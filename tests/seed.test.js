// Tests of the sample data script against a real Postgres, including that the API accepts what it adds.
// TEST_DATABASE_URL must point at a migrated, disposable database: its data is deleted.

const { after, before, beforeEach, test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

require("./testEnv");

const app = require("../src/app");
const db = require("../src/config/db");
const slugify = require("../src/utils/slug");
const { signAccessToken } = require("../src/utils/token");
const { seedCatalog } = require("../scripts/seed-catalog");

let server;
let baseUrl;
const logged = console.log;
const SCRIPT = path.join(__dirname, "../scripts/seed-catalog.js");

before(async () => {
  console.log = () => {};
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}/api`;
});

after(async () => {
  console.log = logged;
  await new Promise((resolve) => server.close(resolve));
  await db.pool.end();
});

beforeEach(async () => {
  await db.query("TRUNCATE users, categories, brands, variant_options CASCADE");
});

async function api(method, route, { body, token } = {}) {
  const response = await fetch(baseUrl + route, {
    method,
    headers: {
      ...(body && { "Content-Type": "application/json" }),
      ...(token && { Authorization: `Bearer ${token}` }),
    },
    body: body && JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function categoryId(slug) {
  const { rows } = await db.query("SELECT id FROM categories WHERE slug = $1 AND deleted_at IS NULL", [slug]);
  return rows[0]?.id;
}

async function counts() {
  const { rows } = await db.query(`SELECT
    (SELECT COUNT(*)::int FROM categories) AS categories,
    (SELECT COUNT(*)::int FROM variant_options) AS options,
    (SELECT COUNT(*)::int FROM variant_option_values) AS values,
    (SELECT COUNT(*)::int FROM category_variant_options) AS assignments`);
  return rows[0];
}

async function makeSeller() {
  const { rows } = await db.query(
    `INSERT INTO users (name, email, role, email_verified_at, terms_accepted_at, terms_version)
     VALUES ('Seller', 'seed-seller@example.com', 'seller', NOW(), NOW(), 'v1') RETURNING id, role`
  );
  await db.query(
    `INSERT INTO seller_profiles (user_id, store_name, store_slug, legal_business_name, verification_status)
     VALUES ($1, 'Store', 'store', 'Legal', 'approved')`,
    [rows[0].id]
  );
  await db.query(
    `WITH address AS (
       INSERT INTO addresses (user_id, full_name, phone, address_line1, city, state, state_code, postal_code)
       VALUES ($1, 'A', '+919876543210', 'L', 'Pune', 'Maharashtra', '27', '411001') RETURNING id
     )
     UPDATE seller_profiles SET pickup_address_id = (SELECT id FROM address) WHERE user_id = $1`,
    [rows[0].id]
  );
  return signAccessToken(rows[0]);
}

test("the tree appears publicly, at most 3 levels deep", async () => {
  const { added, warnings } = await seedCatalog();
  assert.deepEqual(warnings, []);
  assert.ok(added.categories > 15);

  const { body } = await api("GET", "/categories");
  assert.deepEqual(body.categories.map((category) => category.name).sort(), [
    "Books",
    "Clothing",
    "Electronics",
    "Footwear",
    "Home & Kitchen",
  ]);
  const depth = (category) => 1 + Math.max(0, ...category.children.map(depth));
  for (const category of body.categories) assert.ok(depth(category) <= 3, category.name);
});

test("categories inherit options, and a category can make one optional", async () => {
  await seedCatalog();
  const options = async (slug) => (await api("GET", `/categories/${await categoryId(slug)}/variant-options`)).body.options;

  const tshirts = await options("men-s-t-shirts");
  assert.deepEqual(tshirts.map((option) => option.code).sort(), ["colour", "size"]);
  assert.ok(tshirts.every((option) => option.inherited && option.isRequired));
  assert.deepEqual(tshirts.find((option) => option.code === "size").values.map((value) => value.label), ["XS", "S", "M", "L", "XL", "XXL"]);

  assert.deepEqual((await options("smartphones")).map((option) => option.code).sort(), ["colour", "ram", "storage"]);
  assert.equal((await options("sarees")).find((option) => option.code === "size").isRequired, false);
  assert.deepEqual(await options("fiction"), []);
});

test("only colour allows custom values, and every value's code matches what a seller's typing becomes", async () => {
  await seedCatalog();
  const { rows } = await db.query("SELECT code FROM variant_options WHERE allow_custom_values");
  assert.deepEqual(rows.map((row) => row.code), ["colour"]);
  const { rows: values } = await db.query("SELECT label, code FROM variant_option_values");
  for (const value of values) assert.equal(value.code, slugify(value.label));
});

test("a seller can list and publish a product with the sample data, and customers can filter by it", async () => {
  await seedCatalog();
  const token = await makeSeller();
  const categoryIdValue = await categoryId("men-s-t-shirts");

  const product = await api("POST", "/seller/products", {
    token,
    body: {
      categoryId: categoryIdValue,
      title: "Cotton Tee",
      genericName: "T-Shirt",
      countryOfOrigin: "IN",
      manufacturerName: "Maker",
      manufacturerAddress: "1 Road",
    },
  });
  assert.equal(product.status, 201);

  const variant = (options, sku) => ({
    sku,
    options,
    mrp: 999,
    sellingPrice: 499,
    netQuantity: "1 N",
    weightGrams: 200,
    lengthMm: 300,
    widthMm: 200,
    heightMm: 20,
  });
  const route = `/seller/products/${product.body.product.id}`;
  const typed = await api("POST", `${route}/variants`, { token, body: variant({ size: "M", colour: "Red" }, "A") });
  assert.equal(typed.status, 201);
  assert.deepEqual(typed.body.variant.options, { size: "m", colour: "red" });

  const custom = await api("POST", `${route}/variants`, { token, body: variant({ size: "L", colour: "Midnight Blue" }, "B") });
  assert.equal(custom.status, 201);

  const refused = await api("POST", `${route}/variants`, { token, body: variant({ size: "Huge", colour: "Red" }, "C") });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.code, "INVALID_VARIANT_OPTIONS");

  await db.query(
    `INSERT INTO product_images (product_id, storage_provider, storage_key, url, is_primary)
     VALUES ($1, 'r2', 'k', 'https://cdn.test/x.png', TRUE)`,
    [product.body.product.id]
  );
  assert.equal((await api("POST", `${route}/publish`, { token })).status, 200);

  const top = await categoryId("clothing");
  const found = await api("GET", `/products?categoryId=${top}&option=size:m&option=colour:red`);
  assert.equal(found.body.pagination.total, 1);

  // Products can't sit on a category that has sub-categories.
  const parent = await api("POST", "/seller/products", { token, body: { categoryId: top, title: "Nope" } });
  assert.equal(parent.status, 400);
});

test("running it again adds nothing", async () => {
  await seedCatalog();
  const first = await counts();
  const { added, warnings } = await seedCatalog();
  assert.deepEqual(added, { options: 0, values: 0, categories: 0, assignments: 0 });
  assert.deepEqual(warnings, []);
  assert.deepEqual(await counts(), first);
});

test("running it again keeps admins' changes", async () => {
  await seedCatalog();
  const id = await categoryId("books");
  await db.query("UPDATE categories SET name = 'All Books', is_active = FALSE WHERE id = $1", [id]);
  await db.query("UPDATE variant_options SET name = 'Fit Size', allow_custom_values = TRUE WHERE code = 'size'");
  await db.query("UPDATE variant_option_values SET label = 'Medium' WHERE code = 'm'");
  const smartphones = await categoryId("mobiles");
  await db.query(
    "UPDATE category_variant_options SET is_required = FALSE WHERE category_id = $1",
    [smartphones]
  );
  await db.query("DELETE FROM variant_option_values WHERE code = 'xxl'");

  await seedCatalog();

  const { rows } = await db.query("SELECT name, is_active FROM categories WHERE id = $1", [id]);
  assert.deepEqual(rows[0], { name: "All Books", is_active: false });
  const option = await db.query("SELECT name, allow_custom_values FROM variant_options WHERE code = 'size'");
  assert.deepEqual(option.rows[0], { name: "Fit Size", allow_custom_values: true });
  assert.equal((await db.query("SELECT label FROM variant_option_values WHERE code = 'm'")).rows[0].label, "Medium");
  assert.equal(
    (await db.query("SELECT COUNT(*)::int AS n FROM category_variant_options WHERE category_id = $1 AND is_required", [smartphones])).rows[0].n,
    0
  );
  assert.equal((await db.query("SELECT COUNT(*)::int AS n FROM variant_option_values WHERE code = 'xxl'")).rows[0].n, 0);
});

test("a deleted sample category comes back", async () => {
  await seedCatalog();
  await db.query("UPDATE categories SET deleted_at = NOW() WHERE slug = 'fiction'");
  const { added } = await seedCatalog();
  assert.equal(added.categories, 1);
  assert.ok(await categoryId("fiction"));
});

test("an existing category with the same name is reused, not duplicated", async () => {
  const { rows } = await db.query("INSERT INTO categories (name, slug) VALUES ('CLOTHING', 'my-clothes') RETURNING id");
  await seedCatalog();
  assert.equal(await categoryId("clothing"), undefined);
  const { rows: children } = await db.query("SELECT slug FROM categories WHERE parent_id = $1 ORDER BY slug", [rows[0].id]);
  assert.deepEqual(children.map((child) => child.slug), ["men-s-clothing", "women-s-clothing"]);
  // An existing category's options are its own business.
  const assigned = await db.query("SELECT 1 FROM category_variant_options WHERE category_id = $1", [rows[0].id]);
  assert.equal(assigned.rowCount, 0);
});

test("a category with products doesn't get sub-categories", async () => {
  const token = await makeSeller();
  const { rows } = await db.query("INSERT INTO categories (name, slug) VALUES ('Books', 'books') RETURNING id");
  const product = await api("POST", "/seller/products", { token, body: { categoryId: rows[0].id, title: "A Book" } });
  assert.equal(product.status, 201);

  const { warnings } = await seedCatalog();
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /Fiction/);
  const children = await db.query("SELECT 1 FROM categories WHERE parent_id = $1", [rows[0].id]);
  assert.equal(children.rowCount, 0);
  assert.ok(await categoryId("clothing")); // the rest is still added
});

test("the command refuses production and changes nothing", async () => {
  const result = spawnSync(process.execPath, [SCRIPT], {
    env: { PATH: process.env.PATH, NODE_ENV: "production", DATABASE_URL: process.env.DATABASE_URL, JWT_ACCESS_SECRET: "x" },
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /isn't for production/);
  assert.equal((await counts()).categories, 0);
});

test("the command works, and says what it added", async () => {
  const run = () =>
    spawnSync(process.execPath, [SCRIPT], {
      env: { PATH: process.env.PATH, DATABASE_URL: process.env.DATABASE_URL, JWT_ACCESS_SECRET: "x" },
      encoding: "utf8",
    });
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /Added \d+ categories/);
  const second = run();
  assert.match(second.stdout, /Added 0 categories, 0 options, 0 option values, 0 category options/);
  assert.ok((await counts()).categories > 15);
});
