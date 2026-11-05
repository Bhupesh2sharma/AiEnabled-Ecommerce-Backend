// Tests of the cart against a real Postgres.
// TEST_DATABASE_URL must point at a migrated, disposable database: its data is deleted.

const { after, before, beforeEach, test } = require("node:test");
const assert = require("node:assert/strict");

require("./testEnv");

const app = require("../src/app");
const db = require("../src/config/db");
const UserModel = require("../src/models/user.model");
const { signAccessToken } = require("../src/utils/token");

let server;
let baseUrl;
const logged = console.log;

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
  await db.query("TRUNCATE users, categories, brands, variant_options CASCADE");
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

// ---------- Helpers for the API ----------

const MISSING_ID = "00000000-0000-7000-8000-000000000000";

async function api(method, path, { body, as } = {}) {
  const response = await fetch(baseUrl + path, {
    method,
    headers: {
      ...(body && { "Content-Type": "application/json" }),
      ...(as && { Authorization: `Bearer ${as}` }),
    },
    body: body && JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

const tokenFor = (id, role = "customer") => signAccessToken({ id, role });

// A store with a product on sale: { store, userId, categoryId, productId, slug }.
async function makeListing({ parentId = null, title = "Ceramic Mug", image = true, storeName = "Mug House" } = {}) {
  const n = next();
  const userId = await makeUser("seller");
  const store = await db.query(
    `INSERT INTO seller_profiles (user_id, store_name, store_slug, legal_business_name, verification_status, tax_id)
     VALUES ($1, $2, $3, 'Legal', 'approved', '22AAAAA0000A1Z5') RETURNING id`,
    [userId, storeName, `shop-${n}`]
  );
  const category = await db.query("INSERT INTO categories (name, slug, parent_id) VALUES ($1, $1, $2) RETURNING id", [
    `shop-cat-${n}`,
    parentId,
  ]);
  const slug = `shop-product-${n}`;
  const product = await db.query(
    `INSERT INTO products (seller_id, category_id, title, slug, generic_name, country_of_origin, manufacturer_name,
                           manufacturer_address, hsn_code, status)
     VALUES ($1, $2, $3, $4, 'Mug', 'IN', 'Maker', '1 Road', '6912', 'active') RETURNING id`,
    [store.rows[0].id, category.rows[0].id, title, slug]
  );
  const listing = { store: store.rows[0].id, userId, categoryId: category.rows[0].id, productId: product.rows[0].id, slug };
  if (image) await addImage(listing);
  return listing;
}

async function addImage(listing, { url = "https://cdn.test/main.png", variantId = null, isPrimary = true } = {}) {
  await db.query(
    `INSERT INTO product_images (product_id, variant_id, storage_provider, storage_key, url, alt_text, is_primary)
     VALUES ($1, $2, 'r2', $3, $4, 'Front', $5)`,
    [listing.productId, variantId, `shop-key-${next()}`, url, isPrimary]
  );
}

async function addVariant(listing, { price = "300.00", mrp = "600.00", stock = 37, options = {}, labels = {} } = {}) {
  const { rows } = await db.query(
    `INSERT INTO product_variants (product_id, seller_id, sku, options, option_labels, mrp, selling_price, gst_rate,
                                   net_quantity, stock_quantity)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 18, '1 N', $8) RETURNING id`,
    [listing.productId, listing.store, `SECRET-SKU-${next()}`, JSON.stringify(options), JSON.stringify(labels), mrp, price, stock]
  );
  return rows[0].id;
}

// A variant on sale, ready to buy.
async function onSale(fields = {}, listingFields = {}) {
  const listing = await makeListing(listingFields);
  return { listing, variantId: await addVariant(listing, fields) };
}

let token;
const add = (variantId, quantity, as = token) =>
  api("POST", "/cart/items", { as, body: quantity === undefined ? { variantId } : { variantId, quantity } });
const getCart = async (as = token) => (await api("GET", "/cart", { as })).body;
const itemOf = async (variantId) => (await getCart()).items.find((item) => item.variantId === variantId);

beforeEach(() => {
  token = tokenFor(customer);
});

// ---------- Access ----------

test("only customers have a cart", async () => {
  const { variantId } = await onSale();
  const seller = tokenFor(await makeUser("seller"), "seller");
  const admin = tokenFor(await makeUser("admin"), "admin");
  for (const [as, status] of [[seller, 403], [admin, 403], [undefined, 401]]) {
    assert.equal((await api("GET", "/cart", { as })).status, status);
    assert.equal((await api("POST", "/cart/items", { as, body: { variantId } })).status, status);
  }
  assert.equal(await rowCount(customer), 0);
});

// ---------- Viewing ----------

test("an empty cart has zero totals and can't check out", async () => {
  assert.deepEqual(await getCart(), {
    items: [],
    totals: { itemCount: 0, subtotal: "0.00", mrpTotal: "0.00", savings: "0.00" },
    canCheckout: false,
  });
});

test("adding returns the whole cart, with live details and totals", async () => {
  const { listing, variantId } = await onSale();
  const res = await add(variantId, 2);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    items: [
      {
        variantId,
        quantity: 2,
        status: "available",
        maxQuantity: 10,
        productId: listing.productId,
        slug: listing.slug,
        title: "Ceramic Mug",
        image: { url: "https://cdn.test/main.png", altText: "Front" },
        options: [],
        store: { name: "Mug House", slug: res.body.items[0].store.slug },
        price: "300.00",
        mrp: "600.00",
        discountPercent: 50,
        lineTotal: "600.00",
      },
    ],
    totals: { itemCount: 2, subtotal: "600.00", mrpTotal: "1200.00", savings: "600.00" },
    canCheckout: true,
  });
  assert.deepEqual(await getCart(), res.body);
});

test("a discount is rounded down, so it's never overstated", async () => {
  const { variantId } = await onSale({ price: "749.50", mrp: "999.00" });
  await add(variantId);
  assert.equal((await itemOf(variantId)).discountPercent, 24); // 24.97%
});

test("totals are exact, whatever the prices", async () => {
  const first = await onSale({ price: "0.10", mrp: "0.30" });
  const second = await onSale({ price: "0.20", mrp: "0.20" });
  const big = await onSale({ price: "9999999999.99", mrp: "9999999999.99" });
  await add(first.variantId, 3);
  await add(second.variantId, 1);
  let cart = await getCart();
  assert.equal(cart.totals.subtotal, "0.50"); // 0.1 + 0.2 isn't 0.3 in JavaScript numbers
  assert.equal(cart.totals.mrpTotal, "1.10");
  assert.equal(cart.totals.savings, "0.60");
  assert.equal(cart.items.find((item) => item.variantId === first.variantId).lineTotal, "0.30");

  await add(big.variantId, 10);
  cart = await getCart();
  assert.equal(cart.totals.subtotal, "100000000000.40"); // 99999999999.90 + 0.50
  assert.equal(cart.totals.itemCount, 14);
});

test("a price change shows at once", async () => {
  const { variantId } = await onSale();
  await add(variantId, 2);
  await db.query("UPDATE product_variants SET selling_price = 250, mrp = 500 WHERE id = $1", [variantId]);
  const cart = await getCart();
  assert.equal(cart.items[0].price, "250.00");
  assert.equal(cart.items[0].lineTotal, "500.00");
  assert.equal(cart.totals.subtotal, "500.00");
  assert.equal(cart.totals.mrpTotal, "1000.00");
});

test("one cart can hold several sellers' products, newest first", async () => {
  const a = await onSale({}, { storeName: "Store A", title: "A" });
  const b = await onSale({}, { storeName: "Store B", title: "B" });
  await add(a.variantId);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await add(b.variantId);
  const cart = await getCart();
  assert.deepEqual(cart.items.map((item) => item.store.name), ["Store B", "Store A"]);
  assert.equal(cart.canCheckout, true);
  // Adding more of an older item doesn't move it.
  await add(a.variantId);
  assert.deepEqual((await getCart()).items.map((item) => item.title), ["B", "A"]);
});

test("customers' carts are separate", async () => {
  const { variantId } = await onSale();
  await add(variantId, 2);
  const other = tokenFor(await makeUser());
  assert.deepEqual((await getCart(other)).items, []);
  await add(variantId, 5, other);
  assert.equal((await itemOf(variantId)).quantity, 2);
});

test("an item shows the variant's own image, otherwise the main one, never another variant's", async () => {
  const listing = await makeListing({ image: false });
  const red = await addVariant(listing, { options: { colour: "red" } });
  const blue = await addVariant(listing, { options: { colour: "blue" } });
  const plain = await addVariant(listing, { options: { colour: "green" } });
  await addImage(listing, { url: "https://cdn.test/main.png", isPrimary: true });
  await addImage(listing, { url: "https://cdn.test/red.png", variantId: red, isPrimary: false });
  await addImage(listing, { url: "https://cdn.test/blue.png", variantId: blue, isPrimary: false });
  await addImage(listing, { url: "https://cdn.test/side.png", isPrimary: false });
  for (const id of [red, blue, plain]) await add(id);
  assert.equal((await itemOf(red)).image.url, "https://cdn.test/red.png");
  assert.equal((await itemOf(blue)).image.url, "https://cdn.test/blue.png");
  assert.equal((await itemOf(plain)).image.url, "https://cdn.test/main.png");
});

test("options have readable labels, including custom and deleted values", async () => {
  const { rows } = await db.query(
    "INSERT INTO variant_options (name, code, allow_custom_values) VALUES ('Size', 'size', FALSE), ('Colour', 'colour', TRUE) RETURNING id, code"
  );
  const size = rows.find((row) => row.code === "size").id;
  await db.query("INSERT INTO variant_option_values (option_id, label, code) VALUES ($1, 'Medium', 'm'), ($1, 'Large', 'l')", [size]);
  await db.query("UPDATE variant_option_values SET deleted_at = NOW() WHERE code = 'l'");

  const listing = await makeListing();
  const custom = await addVariant(listing, { options: { size: "m", colour: "midnight-blue" }, labels: { colour: "Midnight Blue" } });
  const removed = await addVariant(listing, { options: { size: "l" } });
  await add(custom);
  await add(removed);
  assert.deepEqual((await itemOf(custom)).options, [
    { name: "Colour", label: "Midnight Blue" },
    { name: "Size", label: "Medium" },
  ]);
  assert.deepEqual((await itemOf(removed)).options, [{ name: "Size", label: "Large" }]);
});

test("seller-only data never reaches customers", async () => {
  const { listing, variantId } = await onSale({ stock: 37 });
  await add(variantId);
  const check = (json) => {
    // Quoted or with a colon, because bare digits can appear inside a random id.
    for (const secret of ["SECRET-SKU", "22AAAAA0000A1Z5", '"6912"', "gst", "hsn", "stockQuantity", "sellerId", "Fake brand", ":37"]) {
      assert.equal(json.includes(secret), false, `response contains ${secret}`);
    }
  };
  check(JSON.stringify(await getCart()));

  await db.query("UPDATE products SET blocked_at = NOW(), blocked_reason = 'Fake brand' WHERE id = $1", [listing.productId]);
  const blocked = await getCart();
  check(JSON.stringify(blocked));
  assert.equal(blocked.items[0].status, "unavailable");
});

test("low stock shows only what the customer needs, and stock above the limit stays private", async () => {
  const many = await onSale({ stock: 1000 });
  const few = await onSale({ stock: 3 });
  await add(many.variantId);
  await add(few.variantId);
  assert.equal((await itemOf(many.variantId)).maxQuantity, 10);
  assert.equal((await itemOf(few.variantId)).maxQuantity, 3);
});

// ---------- Item status ----------

test("an item can run short or sell out, and is left out of the totals", async () => {
  const { variantId } = await onSale({ stock: 5 });
  const steady = await onSale({ price: "100.00", mrp: "100.00" });
  await add(variantId, 4);
  await add(steady.variantId, 1);
  assert.equal((await getCart()).canCheckout, true);
  assert.equal((await getCart()).totals.subtotal, "1300.00");

  await db.query("UPDATE product_variants SET stock_quantity = 2 WHERE id = $1", [variantId]);
  let cart = await getCart();
  let item = cart.items.find((row) => row.variantId === variantId);
  assert.equal(item.status, "not_enough_stock");
  assert.equal(item.maxQuantity, 2);
  assert.equal(item.quantity, 4); // left for the customer to change
  assert.equal(item.price, "300.00");
  assert.equal(cart.totals.subtotal, "100.00");
  assert.equal(cart.totals.itemCount, 1);
  assert.equal(cart.canCheckout, false);

  await db.query("UPDATE product_variants SET stock_quantity = 0 WHERE id = $1", [variantId]);
  cart = await getCart();
  item = cart.items.find((row) => row.variantId === variantId);
  assert.equal(item.status, "out_of_stock");
  assert.equal(item.maxQuantity, 0);
  assert.equal(cart.canCheckout, false);

  await db.query("UPDATE product_variants SET stock_quantity = 4 WHERE id = $1", [variantId]);
  assert.equal((await itemOf(variantId)).status, "available");
  assert.equal((await getCart()).canCheckout, true);
});

const hides = [
  ["a paused product", (l) => ["UPDATE products SET status = 'paused' WHERE id = $1", [l.productId]], (l) => ["UPDATE products SET status = 'active' WHERE id = $1", [l.productId]]],
  ["a draft product", (l) => ["UPDATE products SET status = 'draft' WHERE id = $1", [l.productId]], (l) => ["UPDATE products SET status = 'active' WHERE id = $1", [l.productId]]],
  ["a blocked product", (l) => ["UPDATE products SET blocked_at = NOW(), blocked_reason = 'x' WHERE id = $1", [l.productId]], (l) => ["UPDATE products SET blocked_at = NULL, blocked_reason = NULL WHERE id = $1", [l.productId]]],
  ["a deleted product", (l) => ["UPDATE products SET deleted_at = NOW() WHERE id = $1", [l.productId]], (l) => ["UPDATE products SET deleted_at = NULL WHERE id = $1", [l.productId]]],
  ["a suspended store", (l) => ["UPDATE seller_profiles SET verification_status = 'suspended' WHERE id = $1", [l.store]], (l) => ["UPDATE seller_profiles SET verification_status = 'approved' WHERE id = $1", [l.store]]],
  ["a suspended seller account", (l) => ["UPDATE users SET status = 'suspended' WHERE id = $1", [l.userId]], (l) => ["UPDATE users SET status = 'active' WHERE id = $1", [l.userId]]],
  ["a deleted seller account", (l) => ["UPDATE users SET deleted_at = NOW() WHERE id = $1", [l.userId]], (l) => ["UPDATE users SET deleted_at = NULL WHERE id = $1", [l.userId]]],
  ["an inactive category", (l) => ["UPDATE categories SET is_active = FALSE WHERE id = $1", [l.categoryId]], (l) => ["UPDATE categories SET is_active = TRUE WHERE id = $1", [l.categoryId]]],
];

for (const [name, hide, undo] of hides) {
  test(`${name} makes the item unavailable, matching the product page, and undoing it brings it back`, async () => {
    const { listing, variantId } = await onSale();
    const steady = await onSale({ price: "100.00", mrp: "100.00" });
    await add(variantId, 2);
    await add(steady.variantId);

    await db.query(...hide(listing));
    assert.equal((await api("GET", `/products/${listing.slug}`)).status, 404);
    const cart = await getCart();
    const item = cart.items.find((row) => row.variantId === variantId);
    assert.equal(item.status, "unavailable");
    assert.equal(item.maxQuantity, 0);
    assert.equal(item.title, "Ceramic Mug"); // still shows what it was
    for (const field of ["price", "mrp", "discountPercent", "lineTotal"]) assert.equal(item[field], null, field);
    assert.equal(cart.totals.subtotal, "100.00");
    assert.equal(cart.totals.itemCount, 1);
    assert.equal(cart.canCheckout, false);
    assert.equal((await add(variantId)).body.code, "PRODUCT_UNAVAILABLE");

    await db.query(...undo(listing));
    assert.equal((await api("GET", `/products/${listing.slug}`)).status, 200);
    assert.equal((await itemOf(variantId)).status, "available");
    assert.equal((await getCart()).canCheckout, true);
  });
}

test("an inactive parent category makes the item unavailable", async () => {
  const top = await db.query("INSERT INTO categories (name, slug) VALUES ('Top', 'top') RETURNING id");
  const { variantId } = await onSale({}, { parentId: top.rows[0].id });
  await add(variantId);
  await db.query("UPDATE categories SET is_active = FALSE WHERE id = $1", [top.rows[0].id]);
  assert.equal((await itemOf(variantId)).status, "unavailable");
});

test("an inactive or deleted variant is unavailable, while the product's other variants still sell", async () => {
  const listing = await makeListing();
  const inactive = await addVariant(listing, { options: { a: "1" } });
  const deleted = await addVariant(listing, { options: { a: "2" } });
  const fine = await addVariant(listing, { options: { a: "3" } });
  for (const id of [inactive, deleted, fine]) await add(id);

  await db.query("UPDATE product_variants SET is_active = FALSE WHERE id = $1", [inactive]);
  await db.query("UPDATE product_variants SET deleted_at = NOW() WHERE id = $1", [deleted]);
  assert.equal((await itemOf(inactive)).status, "unavailable");
  assert.equal((await itemOf(deleted)).status, "unavailable");
  assert.equal((await itemOf(fine)).status, "available");
});

test("a product whose images are all gone is unavailable, and its item has no image", async () => {
  const { listing, variantId } = await onSale();
  await add(variantId);
  await db.query("DELETE FROM product_images WHERE product_id = $1", [listing.productId]);
  const item = await itemOf(variantId);
  assert.equal(item.status, "unavailable");
  assert.equal(item.image, null);
});

// ---------- Adding ----------

test("quantity defaults to 1, and adding again adds to it", async () => {
  const { variantId } = await onSale();
  assert.equal((await add(variantId)).body.items[0].quantity, 1);
  assert.equal((await add(variantId, 3)).body.items[0].quantity, 4);
  assert.equal(await rowCount(customer), 1);
});

test("bad input gets a 400", async () => {
  const { variantId } = await onSale();
  const bad = [
    {},
    { quantity: 1 },
    { variantId: "abc" },
    { variantId, quantity: 0 },
    { variantId, quantity: -1 },
    { variantId, quantity: 11 },
    { variantId, quantity: 1.5 },
    { variantId, quantity: "2" },
    { variantId, price: "1.00" },
  ];
  for (const body of bad) {
    const res = await api("POST", "/cart/items", { as: token, body });
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(res.body.code, "VALIDATION_ERROR");
  }
  assert.equal(await rowCount(customer), 0);
});

test("an unknown variant gets the same answer as a hidden one", async () => {
  const { listing, variantId } = await onSale();
  await db.query("UPDATE products SET status = 'paused' WHERE id = $1", [listing.productId]);
  const hidden = await add(variantId);
  const unknown = await add(MISSING_ID);
  assert.equal(hidden.status, 409);
  assert.equal(hidden.body.code, "PRODUCT_UNAVAILABLE");
  assert.deepEqual(unknown, hidden);
  assert.equal(await rowCount(customer), 0);
});

test("an inactive or deleted variant, or one sold out, can't be added", async () => {
  const listing = await makeListing();
  const inactive = await addVariant(listing, { options: { a: "1" } });
  const deleted = await addVariant(listing, { options: { a: "2" } });
  const soldOut = await addVariant(listing, { options: { a: "3" }, stock: 0 });
  await addVariant(listing, { options: { a: "4" } });
  await db.query("UPDATE product_variants SET is_active = FALSE WHERE id = $1", [inactive]);
  await db.query("UPDATE product_variants SET deleted_at = NOW() WHERE id = $1", [deleted]);
  assert.equal((await add(inactive)).body.code, "PRODUCT_UNAVAILABLE");
  assert.equal((await add(deleted)).body.code, "PRODUCT_UNAVAILABLE");
  const res = await add(soldOut);
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "OUT_OF_STOCK");
  assert.equal(await rowCount(customer), 0);
});

test("a quantity can't pass the stock, counting what's already in the cart", async () => {
  const { variantId } = await onSale({ stock: 3 });
  const tooMany = await add(variantId, 4);
  assert.equal(tooMany.status, 409);
  assert.equal(tooMany.body.code, "NOT_ENOUGH_STOCK");
  assert.equal(tooMany.body.details[0].maxQuantity, 3);
  assert.equal(await rowCount(customer), 0);

  assert.equal((await add(variantId, 2)).status, 200);
  assert.equal((await add(variantId, 2)).body.code, "NOT_ENOUGH_STOCK");
  assert.equal((await itemOf(variantId)).quantity, 2);
  assert.equal((await add(variantId, 1)).status, 200);
});

test("a quantity can't pass 10 per item", async () => {
  const { variantId } = await onSale({ stock: 100 });
  await add(variantId, 8);
  const res = await add(variantId, 3);
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "QUANTITY_LIMIT_REACHED");
  assert.equal(res.body.details[0].maxQuantity, 10);
  assert.equal((await itemOf(variantId)).quantity, 8); // not quietly capped
  assert.equal((await add(variantId, 2)).body.items[0].quantity, 10);
});

test("a cart can hold 50 different items, and more of one it already has", async () => {
  const listing = await makeListing();
  const variants = [];
  for (let i = 0; i < 51; i += 1) variants.push(await addVariant(listing, { options: { n: String(i) } }));
  for (const id of variants.slice(0, 50)) await addRow(customer, id);

  const over = await add(variants[50]);
  assert.equal(over.status, 409);
  assert.equal(over.body.code, "CART_LIMIT_REACHED");
  assert.equal(await rowCount(customer), 50);

  assert.equal((await add(variants[0])).status, 200);
  const other = tokenFor(await makeUser());
  assert.equal((await add(variants[50], 1, other)).status, 200);
});

// ---------- Requests arriving together ----------

test("parallel adds of one variant can't pass 10", async () => {
  const { variantId } = await onSale({ stock: 100 });
  const results = await Promise.all(Array.from({ length: 15 }, () => add(variantId, 1)));
  assert.equal(results.filter((res) => res.status === 200).length, 10);
  const refused = results.filter((res) => res.status !== 200);
  assert.ok(refused.every((res) => res.body.code === "QUANTITY_LIMIT_REACHED"), JSON.stringify(refused.map((res) => res.body)));
  assert.equal((await itemOf(variantId)).quantity, 10);
});

test("parallel adds of one variant lose no quantity", async () => {
  const { variantId } = await onSale({ stock: 100 });
  const results = await Promise.all(Array.from({ length: 8 }, () => add(variantId, 1)));
  assert.ok(results.every((res) => res.status === 200), JSON.stringify(results.map((res) => res.status)));
  assert.equal((await itemOf(variantId)).quantity, 8);
});

test("parallel adds of one variant can't pass the stock", async () => {
  const { variantId } = await onSale({ stock: 4 });
  const results = await Promise.all(Array.from({ length: 8 }, () => add(variantId, 1)));
  assert.equal(results.filter((res) => res.status === 200).length, 4);
  assert.equal((await itemOf(variantId)).quantity, 4);
});

test("parallel adds of different variants can't pass 50 items", async () => {
  const listing = await makeListing();
  const variants = [];
  for (let i = 0; i < 12; i += 1) variants.push(await addVariant(listing, { options: { n: String(i) } }));
  // 45 are already there, leaving room for 5 of these 12.
  for (let i = 0; i < 45; i += 1) await addRow(customer, await addVariant(listing, { options: { m: String(i) } }));
  const results = await Promise.all(variants.map((id) => add(id)));
  assert.equal(results.filter((res) => res.status === 200).length, 5);
  assert.equal(await rowCount(customer), 50);
});

// ---------- Changing and removing ----------

const change = (variantId, quantity, as = token) => api("PATCH", `/cart/items/${variantId}`, { as, body: { quantity } });
const remove = (variantId, as = token) => api("DELETE", `/cart/items/${variantId}`, { as });
const clearCart = (as = token) => api("DELETE", "/cart", { as });

test("only customers can change, remove or empty", async () => {
  const seller = tokenFor(await makeUser("seller"), "seller");
  const admin = tokenFor(await makeUser("admin"), "admin");
  for (const [as, status] of [[seller, 403], [admin, 403], [undefined, 401]]) {
    assert.equal((await api("PATCH", `/cart/items/${MISSING_ID}`, { as, body: { quantity: 1 } })).status, status);
    assert.equal((await api("DELETE", `/cart/items/${MISSING_ID}`, { as })).status, status);
    assert.equal((await api("DELETE", "/cart", { as })).status, status);
  }
});

test("changing sets the quantity, not adds to it, and returns the whole cart", async () => {
  const { variantId } = await onSale();
  await add(variantId, 2);
  const res = await change(variantId, 5);
  assert.equal(res.status, 200);
  assert.equal(res.body.items[0].quantity, 5);
  assert.equal(res.body.totals.subtotal, "1500.00");
  assert.equal((await change(variantId, 1)).body.items[0].quantity, 1);
  assert.equal((await change(variantId, 1)).status, 200); // the same quantity is fine
});

test("bad changes get a 400", async () => {
  const { variantId } = await onSale();
  await add(variantId, 2);
  for (const quantity of [0, -1, 11, 1.5, "2", null]) {
    assert.equal((await change(variantId, quantity)).status, 400, String(quantity));
  }
  const noBody = await api("PATCH", `/cart/items/${variantId}`, { as: token, body: {} });
  assert.equal(noBody.status, 400);
  const extra = await api("PATCH", `/cart/items/${variantId}`, { as: token, body: { quantity: 1, price: "1.00" } });
  assert.equal(extra.status, 400);
  assert.equal((await api("PATCH", "/cart/items/abc", { as: token, body: { quantity: 1 } })).status, 400);
  assert.equal((await remove("abc")).status, 400);
  assert.equal((await itemOf(variantId)).quantity, 2);
});

test("raising a quantity can't pass the stock", async () => {
  const { variantId } = await onSale({ stock: 3 });
  await add(variantId, 1);
  const res = await change(variantId, 4);
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "NOT_ENOUGH_STOCK");
  assert.equal(res.body.details[0].maxQuantity, 3);
  assert.equal((await itemOf(variantId)).quantity, 1);
  assert.equal((await change(variantId, 3)).status, 200);
});

test("a customer can fix an item that ran short by lowering it", async () => {
  const { variantId } = await onSale({ stock: 5 });
  await add(variantId, 4);
  await db.query("UPDATE product_variants SET stock_quantity = 2 WHERE id = $1", [variantId]);
  assert.equal((await itemOf(variantId)).status, "not_enough_stock");

  // Lowering helps even if it isn't enough yet, and raising is refused.
  assert.equal((await change(variantId, 3)).status, 200);
  assert.equal((await itemOf(variantId)).status, "not_enough_stock");
  assert.equal((await change(variantId, 4)).body.code, "NOT_ENOUGH_STOCK");

  const fixed = await change(variantId, 2);
  assert.equal(fixed.status, 200);
  assert.equal(fixed.body.items[0].status, "available");
  assert.equal(fixed.body.canCheckout, true);
});

test("a sold-out item can be lowered but not raised", async () => {
  const { variantId } = await onSale({ stock: 5 });
  await add(variantId, 3);
  await db.query("UPDATE product_variants SET stock_quantity = 0 WHERE id = $1", [variantId]);
  const raised = await change(variantId, 4);
  assert.equal(raised.status, 409);
  assert.equal(raised.body.code, "OUT_OF_STOCK");
  assert.equal((await change(variantId, 1)).status, 200);
  assert.equal((await itemOf(variantId)).status, "out_of_stock");
});

test("an unavailable item can't be changed, only removed", async () => {
  const { listing, variantId } = await onSale();
  await add(variantId, 3);
  await db.query("UPDATE products SET status = 'paused' WHERE id = $1", [listing.productId]);
  for (const quantity of [1, 3, 5]) {
    const res = await change(variantId, quantity);
    assert.equal(res.status, 409, String(quantity));
    assert.equal(res.body.code, "PRODUCT_UNAVAILABLE");
  }
  assert.equal((await itemOf(variantId)).quantity, 3);

  const removed = await remove(variantId);
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.body.items, []);
});

test("changing or removing what's not in the cart is a 404, and adds nothing", async () => {
  const { variantId } = await onSale();
  for (const id of [variantId, MISSING_ID]) {
    const changed = await change(id, 1);
    assert.equal(changed.status, 404);
    assert.equal(changed.body.code, "NOT_FOUND");
    assert.equal((await remove(id)).status, 404);
  }
  assert.equal(await rowCount(customer), 0);
});

test("removing takes out one item, and returns the updated cart", async () => {
  const a = await onSale({ price: "100.00", mrp: "100.00" });
  const b = await onSale({ price: "200.00", mrp: "200.00" });
  await add(a.variantId);
  await add(b.variantId);
  const res = await remove(a.variantId);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.items.map((item) => item.variantId), [b.variantId]);
  assert.equal(res.body.totals.subtotal, "200.00");
  assert.equal((await remove(a.variantId)).status, 404);
  // A removed item can be added again from the start.
  assert.equal((await add(a.variantId, 2)).body.items.find((item) => item.variantId === a.variantId).quantity, 2);
});

test("removing an item frees a place under the 50-item limit", async () => {
  const listing = await makeListing();
  const variants = [];
  for (let i = 0; i < 51; i += 1) variants.push(await addVariant(listing, { options: { n: String(i) } }));
  for (const id of variants.slice(0, 50)) await addRow(customer, id);
  assert.equal((await add(variants[50])).body.code, "CART_LIMIT_REACHED");
  await remove(variants[0]);
  assert.equal((await add(variants[50])).status, 200);
});

test("emptying removes everything, whatever its status, and repeating it is fine", async () => {
  const { listing, variantId } = await onSale();
  const other = await onSale();
  await add(variantId);
  await add(other.variantId);
  await db.query("UPDATE products SET status = 'paused' WHERE id = $1", [listing.productId]);

  const res = await clearCart();
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    items: [],
    totals: { itemCount: 0, subtotal: "0.00", mrpTotal: "0.00", savings: "0.00" },
    canCheckout: false,
  });
  assert.equal(await rowCount(customer), 0);
  assert.equal((await clearCart()).status, 200);
});

test("changing, removing and emptying leave other customers' carts alone", async () => {
  const { variantId } = await onSale();
  const other = tokenFor(await makeUser());
  await add(variantId, 2, other);

  assert.equal((await change(variantId, 5)).status, 404);
  assert.equal((await remove(variantId)).status, 404);
  await clearCart();
  const theirs = await getCart(other);
  assert.equal(theirs.items.length, 1);
  assert.equal(theirs.items[0].quantity, 2);
});

test("a removed item stays removed when a change arrives at the same moment", async () => {
  const { variantId } = await onSale();
  for (let round = 0; round < 30; round += 1) {
    await add(variantId, 1);
    const [changed, removed] = await Promise.all([change(variantId, 2), remove(variantId)]);
    assert.equal(removed.status, 200, `round ${round}`);
    assert.ok([200, 404].includes(changed.status), `round ${round}: ${changed.status}`);
    assert.equal(await rowCount(customer), 0, `round ${round}: change ${changed.status}`);
  }
});

test("emptying can't leave an item that a change was updating", async () => {
  const { variantId } = await onSale();
  for (let round = 0; round < 30; round += 1) {
    await add(variantId, 1);
    await Promise.all([change(variantId, 2), clearCart()]);
    assert.equal(await rowCount(customer), 0, `round ${round}`);
  }
});

// A race between checking and saving is too brief to hit reliably, so this holds the lock open instead.
for (const [name, send] of [
  ["removing", (variantId) => remove(variantId)],
  ["emptying", () => clearCart()],
]) {
  test(`${name} waits for a change in progress, so it can't slip between its check and its save`, async () => {
    const { variantId } = await onSale();
    await add(variantId, 1);

    let finished = false;
    let request;
    await db.transaction(async (client) => {
      await UserModel.lockForChange(customer, client);
      request = send(variantId).then((res) => {
        finished = true;
        return res;
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(finished, false);
    });
    assert.equal((await request).status, 200);
    assert.equal(await rowCount(customer), 0);
  });
}

test("parallel changes leave one of the quantities sent", async () => {
  const { variantId } = await onSale({ stock: 100 });
  await add(variantId, 1);
  const results = await Promise.all([2, 3, 4, 5, 6, 7].map((quantity) => change(variantId, quantity)));
  assert.ok(results.every((res) => res.status === 200));
  assert.ok([2, 3, 4, 5, 6, 7].includes((await itemOf(variantId)).quantity));
  assert.equal(await rowCount(customer), 1);
});
