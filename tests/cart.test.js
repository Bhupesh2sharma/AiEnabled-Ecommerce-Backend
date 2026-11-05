// Tests of the cart against a real Postgres.
// TEST_DATABASE_URL must point at a migrated, disposable database: its data is deleted.

const { after, beforeEach, test } = require("node:test");
const assert = require("node:assert/strict");

require("./testEnv");

const db = require("../src/config/db");

after(() => db.pool.end());

let counter = 0;
const next = () => (counter += 1);

async function makeUser(role = "customer") {
  const { rows } = await db.query(
    `INSERT INTO users (name, email, role, email_verified_at, terms_accepted_at, terms_version)
     VALUES ('Test', $1, $2, NOW(), NOW(), 'v1') RETURNING id`,
    [`cart${next()}@example.com`, role]
  );
  return rows[0].id;
}

async function makeVariant() {
  const n = next();
  const seller = await db.query(
    `INSERT INTO seller_profiles (user_id, store_name, store_slug, legal_business_name)
     VALUES ($1, 'Store', $2, 'Legal') RETURNING id`,
    [await makeUser("seller"), `cart-store-${n}`]
  );
  const category = await db.query("INSERT INTO categories (name, slug) VALUES ($1, $1) RETURNING id", [`cart-cat-${n}`]);
  const product = await db.query(
    "INSERT INTO products (seller_id, category_id, title, slug) VALUES ($1, $2, 'Mug', $3) RETURNING id",
    [seller.rows[0].id, category.rows[0].id, `cart-product-${n}`]
  );
  const { rows } = await db.query(
    `INSERT INTO product_variants (product_id, seller_id, sku, mrp, selling_price)
     VALUES ($1, $2, $3, 600, 300) RETURNING id`,
    [product.rows[0].id, seller.rows[0].id, `CART-${n}`]
  );
  return rows[0].id;
}

const addRow = (userId, variantId, quantity = 1) =>
  db.query("INSERT INTO cart_items (user_id, variant_id, quantity) VALUES ($1, $2, $3)", [userId, variantId, quantity]);

const rowCount = async (userId) =>
  (await db.query("SELECT COUNT(*)::int AS n FROM cart_items WHERE user_id = $1", [userId])).rows[0].n;

const fails = (promise, code) => assert.rejects(promise, (err) => err.code === code);

let customer;
let variant;

beforeEach(async () => {
  await db.query("TRUNCATE users, categories, brands CASCADE");
  customer = await makeUser();
  variant = await makeVariant();
});

// ---------- The table ----------

test("a quantity must be 1 to 10", async () => {
  for (const quantity of [0, -1, 11, 1000]) await fails(addRow(customer, variant, quantity), "23514");
  await fails(addRow(customer, variant, null), "23502");
  assert.equal(await rowCount(customer), 0);

  await addRow(customer, variant, 1);
  await db.query("UPDATE cart_items SET quantity = 10 WHERE user_id = $1", [customer]);
  await fails(db.query("UPDATE cart_items SET quantity = 11 WHERE user_id = $1", [customer]), "23514");
});

test("a cart has one row per variant, and customers' carts are separate", async () => {
  await addRow(customer, variant);
  await fails(addRow(customer, variant), "23505");

  await addRow(customer, await makeVariant());
  assert.equal(await rowCount(customer), 2);

  const other = await makeUser();
  await addRow(other, variant);
  assert.equal(await rowCount(other), 1);
});

test("an unknown user or variant is refused", async () => {
  const missing = "00000000-0000-7000-8000-000000000000";
  await fails(addRow(missing, variant), "23503");
  await fails(addRow(customer, missing), "23503");
});

test("deleting a user removes their cart, and only theirs", async () => {
  const other = await makeUser();
  await addRow(customer, variant);
  await addRow(other, variant);
  await db.query("DELETE FROM users WHERE id = $1", [customer]);
  assert.equal(await rowCount(customer), 0);
  assert.equal(await rowCount(other), 1);
});

test("a soft-deleted variant stays in the cart, and a really deleted one leaves", async () => {
  await addRow(customer, variant);
  await db.query("UPDATE product_variants SET deleted_at = NOW() WHERE id = $1", [variant]);
  assert.equal(await rowCount(customer), 1);

  await db.query("DELETE FROM product_variants WHERE id = $1", [variant]);
  assert.equal(await rowCount(customer), 0);
});

test("changing a row updates updated_at", async () => {
  await addRow(customer, variant);
  const read = async () =>
    (await db.query("SELECT created_at, updated_at FROM cart_items WHERE user_id = $1", [customer])).rows[0];
  const before = await read();
  await new Promise((resolve) => setTimeout(resolve, 5));
  await db.query("UPDATE cart_items SET quantity = 2 WHERE user_id = $1", [customer]);
  const changed = await read();
  assert.ok(changed.updated_at > before.updated_at);
  assert.deepEqual(changed.created_at, before.created_at);
});
