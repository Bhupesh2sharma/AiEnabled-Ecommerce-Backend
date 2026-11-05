// End-to-end tests of admins reviewing, blocking and unblocking products against a real Postgres.
// TEST_DATABASE_URL must point at a migrated, disposable database: its data is deleted.

const { after, before, beforeEach, test } = require("node:test");
const assert = require("node:assert/strict");

require("./testEnv");

const app = require("../src/app");
const db = require("../src/config/db");
const { signAccessToken } = require("../src/utils/token");

let server;
let baseUrl;
const logged = console.log;
const MISSING_ID = "00000000-0000-7000-8000-000000000000";
const GSTIN = "22AAAAA0000A1Z5";

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

async function api(method, path, { body, token } = {}) {
  const response = await fetch(baseUrl + path, {
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

let counter = 0;
const next = () => (counter += 1);

async function makeUser(role) {
  const { rows } = await db.query(
    `INSERT INTO users (name, email, role, email_verified_at, terms_accepted_at, terms_version)
     VALUES ('Test', $1, $2, NOW(), NOW(), 'v1') RETURNING id, role`,
    [`mod${next()}@example.com`, role]
  );
  return { id: rows[0].id, token: signAccessToken(rows[0]) };
}

async function makeSeller(storeName = "Store") {
  const user = await makeUser("seller");
  const { rows } = await db.query(
    `INSERT INTO seller_profiles (user_id, store_name, store_slug, legal_business_name, verification_status)
     VALUES ($1, $2, $3, 'Legal', 'approved') RETURNING id`,
    [user.id, storeName, `store-${next()}`]
  );
  return { id: rows[0].id, token: user.token };
}

// A complete product in the given status, ready for customers if `active`.
async function makeProduct(owner, { status = "active", title = "Ceramic Mug" } = {}) {
  const n = next();
  const { rows } = await db.query(
    `INSERT INTO products (seller_id, category_id, title, slug, generic_name, country_of_origin, manufacturer_name,
                           manufacturer_address, status, min_price)
     VALUES ($1, $2, $3, $4, 'Mug', 'IN', 'Maker', '1 Road', $5, 300) RETURNING id, slug`,
    [owner.id, categoryId, title, `product-${n}`, status]
  );
  const product = rows[0];
  await db.query(
    `INSERT INTO product_variants (product_id, seller_id, sku, mrp, selling_price, net_quantity, weight_grams,
                                   length_mm, width_mm, height_mm, stock_quantity)
     VALUES ($1, $2, $3, 600, 300, '1 N', 300, 100, 100, 100, 5)`,
    [product.id, owner.id, `SKU-${n}`]
  );
  await db.query(
    `INSERT INTO product_images (product_id, storage_provider, storage_key, url, is_primary)
     VALUES ($1, 'r2', $2, 'https://cdn.test/x.png', TRUE)`,
    [product.id, `key-${n}`]
  );
  return product;
}

const admin = (method, path, body, token = adminUser.token) => api(method, `/admin${path}`, { body, token });
const block = (id, reason = "Fake brand") => admin("POST", `/products/${id}/block`, { reason });
const unblock = (id) => admin("POST", `/products/${id}/unblock`);
const isPublic = async (product) => (await api("GET", `/products/${product.slug}`)).status === 200;

let adminUser;
let seller;
let categoryId;

beforeEach(async () => {
  await db.query("TRUNCATE users, categories, brands, variant_options CASCADE");
  adminUser = await makeUser("admin");
  seller = await makeSeller();
  const { rows } = await db.query("INSERT INTO categories (name, slug) VALUES ('Mugs', 'mugs') RETURNING id");
  categoryId = rows[0].id;
});

// ---------- Access ----------

test("only admins can reach these endpoints", async () => {
  const product = await makeProduct(seller);
  const customer = await makeUser("customer");
  const calls = [
    ["GET", "/products"],
    ["GET", `/products/${product.id}`],
    ["POST", `/products/${product.id}/block`, { reason: "x" }],
    ["POST", `/products/${product.id}/unblock`],
  ];
  for (const [method, path, body] of calls) {
    assert.equal((await api(method, `/admin${path}`, { body })).status, 401, path);
    assert.equal((await admin(method, path, body, seller.token)).status, 403, path);
    assert.equal((await admin(method, path, body, customer.token)).status, 403, path);
  }
  assert.equal(await isPublic(product), true);
});

// ---------- Blocking ----------

test("blocking hides a product at once, and records who, when and why", async () => {
  const product = await makeProduct(seller);
  assert.equal(await isPublic(product), true);

  const res = await block(product.id, "  Fake brand  ");
  assert.equal(res.status, 200);
  assert.equal(res.body.product.isBlocked, true);
  assert.equal(res.body.product.blockedReason, "Fake brand");
  assert.equal(res.body.product.blockedBy, adminUser.id);
  assert.ok(res.body.product.blockedAt);
  assert.equal(res.body.product.status, "active"); // left alone, so unblocking can restore it

  assert.equal(await isPublic(product), false);
  assert.equal((await api("GET", "/products")).body.pagination.total, 0);
});

test("unblocking a live product puts it back on sale and clears the block", async () => {
  const product = await makeProduct(seller);
  await block(product.id);
  const res = await unblock(product.id);
  assert.equal(res.status, 200);
  assert.equal(res.body.product.isBlocked, false);
  assert.equal(res.body.product.blockedReason, null);
  assert.equal(res.body.product.blockedBy, null);
  assert.equal(res.body.product.blockedAt, null);
  assert.equal(res.body.product.status, "active");
  assert.equal(await isPublic(product), true);
});

for (const status of ["draft", "paused"]) {
  test(`unblocking a ${status} product leaves it off sale`, async () => {
    const product = await makeProduct(seller, { status });
    await block(product.id);
    const res = await unblock(product.id);
    assert.equal(res.body.product.status, status);
    assert.equal(await isPublic(product), false);
  });
}

test("unblocking doesn't bring back a product whose seller is suspended", async () => {
  const product = await makeProduct(seller);
  await block(product.id);
  await db.query("UPDATE seller_profiles SET verification_status = 'suspended' WHERE id = $1", [seller.id]);
  assert.equal((await unblock(product.id)).status, 200);
  assert.equal(await isPublic(product), false);
});

test("a reason is required, and limited in length", async () => {
  const product = await makeProduct(seller);
  for (const body of [{}, { reason: "" }, { reason: "   " }, { reason: "x".repeat(1001) }, { reason: 5 }, { reason: "x", extra: 1 }]) {
    const res = await admin("POST", `/products/${product.id}/block`, body);
    assert.equal(res.status, 400, JSON.stringify(body).slice(0, 40));
    assert.equal(res.body.code, "VALIDATION_ERROR");
  }
  assert.equal(await isPublic(product), true);
});

test("blocking twice is refused and keeps the first record; unblocking an unblocked product is refused", async () => {
  const product = await makeProduct(seller);
  assert.equal((await unblock(product.id)).body.code, "INVALID_STATUS_CHANGE");
  await block(product.id, "First");
  const again = await block(product.id, "Second");
  assert.equal(again.status, 409);
  assert.equal(again.body.code, "INVALID_STATUS_CHANGE");
  assert.equal((await admin("GET", `/products/${product.id}`)).body.product.blockedReason, "First");
});

test("when two admins block at once, one wins and its reason stays", async () => {
  for (let round = 0; round < 10; round += 1) {
    const product = await makeProduct(seller);
    const results = await Promise.all([block(product.id, "A"), block(product.id, "B")]);
    const winners = results.filter((res) => res.status === 200);
    assert.equal(winners.length, 1, `round ${round}`);
    const { blockedReason } = (await admin("GET", `/products/${product.id}`)).body.product;
    assert.equal(blockedReason, winners[0].body.product.blockedReason);
  }
});

test("unknown or deleted products are 404, and a bad id is 400", async () => {
  const product = await makeProduct(seller);
  await db.query("UPDATE products SET deleted_at = NOW() WHERE id = $1", [product.id]);
  for (const id of [MISSING_ID, product.id]) {
    assert.equal((await block(id)).status, 404);
    assert.equal((await unblock(id)).status, 404);
    assert.equal((await admin("GET", `/products/${id}`)).status, 404);
  }
  const { rows } = await db.query("SELECT blocked_at FROM products WHERE id = $1", [product.id]);
  assert.equal(rows[0].blocked_at, null); // the refused block wrote nothing
  assert.equal((await block("abc")).status, 400);
  assert.equal((await unblock("abc")).status, 400);
});

// ---------- What the seller can do ----------

test("the seller sees the block and reason, and can't publish", async () => {
  const product = await makeProduct(seller, { status: "paused" });
  await block(product.id, "Fake brand");

  const page = await api("GET", `/seller/products/${product.id}`, { token: seller.token });
  assert.equal(page.body.product.isBlocked, true);
  assert.equal(page.body.product.blockedReason, "Fake brand");
  const list = await api("GET", "/seller/products", { token: seller.token });
  assert.equal(list.body.products[0].isBlocked, true);

  const publish = await api("POST", `/seller/products/${product.id}/publish`, { token: seller.token });
  assert.equal(publish.status, 403);
  assert.equal(publish.body.code, "PRODUCT_BLOCKED");
  assert.match(publish.body.message, /Fake brand/);
});

test("the seller can fix a blocked product, which stays hidden until an admin unblocks it", async () => {
  const product = await makeProduct(seller);
  await block(product.id);

  const edit = await api("PATCH", `/seller/products/${product.id}`, { token: seller.token, body: { title: "Plain Mug" } });
  assert.equal(edit.status, 200);
  assert.equal(edit.body.product.isBlocked, true);
  assert.equal(await isPublic(product), false);

  // Sellers have no way to clear a block themselves.
  const clear = await api("PATCH", `/seller/products/${product.id}`, { token: seller.token, body: { blockedAt: null } });
  assert.equal(clear.status, 400);

  assert.equal((await admin("GET", `/products/${product.id}`)).body.product.title, "Plain Mug");
  await unblock(product.id);
  assert.equal(await isPublic(product), true);
});

test("a blocked product a seller pauses stays paused after unblocking", async () => {
  const product = await makeProduct(seller);
  await block(product.id);
  assert.equal((await api("POST", `/seller/products/${product.id}/pause`, { token: seller.token })).status, 200);
  await unblock(product.id);
  assert.equal(await isPublic(product), false);
});

test("a GSTIN change while blocked returns the product to draft, so unblocking doesn't publish it", async () => {
  const product = await makeProduct(seller);
  await block(product.id);
  const res = await api("PATCH", "/seller/profile", { token: seller.token, body: { taxId: GSTIN } });
  assert.equal(res.status, 200);
  assert.equal(res.body.productsUnpublished, 1);
  const after = await unblock(product.id);
  assert.equal(after.body.product.status, "draft");
  assert.equal(await isPublic(product), false);
});

test("a seller can delete a blocked product, and it leaves the admin list", async () => {
  const product = await makeProduct(seller);
  await block(product.id);
  assert.equal((await api("DELETE", `/seller/products/${product.id}`, { token: seller.token })).status, 204);
  assert.equal((await admin("GET", "/products")).body.pagination.total, 0);
  const { rows } = await db.query("SELECT blocked_reason FROM products WHERE id = $1", [product.id]);
  assert.equal(rows[0].blocked_reason, "Fake brand"); // kept in the database as a record
});

// ---------- The admin list ----------

test("the list has every seller's products in any status, including blocked, and not deleted ones", async () => {
  const other = await makeSeller("Other Store");
  const draft = await makeProduct(seller, { status: "draft", title: "A draft" });
  const paused = await makeProduct(other, { status: "paused", title: "B paused" });
  const blocked = await makeProduct(seller, { title: "C blocked" });
  await block(blocked.id);
  const deleted = await makeProduct(seller, { title: "D deleted" });
  await db.query("UPDATE products SET deleted_at = NOW() WHERE id = $1", [deleted.id]);

  const res = await admin("GET", "/products");
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.pagination, { page: 1, limit: 50, total: 3 });
  assert.deepEqual(new Set(res.body.products.map((row) => row.id)), new Set([draft.id, paused.id, blocked.id]));

  const row = res.body.products.find((item) => item.id === paused.id);
  assert.equal(row.store.name, "Other Store");
  assert.equal(row.store.verificationStatus, "approved");
  assert.equal(row.sellerId, other.id);
  assert.equal(row.variantCount, 1);
  assert.equal(row.primaryImageUrl, "https://cdn.test/x.png");
});

test("the list filters by status, blocked and seller", async () => {
  const other = await makeSeller();
  await makeProduct(seller, { title: "Live" });
  await makeProduct(seller, { status: "draft", title: "Draft" });
  const blocked = await makeProduct(other, { title: "Blocked" });
  await block(blocked.id);

  const titles = async (query) => (await admin("GET", `/products?${query}`)).body.products.map((row) => row.title).sort();
  assert.deepEqual(await titles("status=draft"), ["Draft"]);
  assert.deepEqual(await titles("status=active"), ["Blocked", "Live"]);
  assert.deepEqual(await titles("blocked=true"), ["Blocked"]);
  assert.deepEqual(await titles("blocked=false"), ["Draft", "Live"]);
  assert.deepEqual(await titles("status=active&blocked=false"), ["Live"]);
  assert.deepEqual(await titles(`sellerId=${other.id}`), ["Blocked"]);
  assert.deepEqual(await titles(`sellerId=${seller.id}&status=active`), ["Live"]);
});

test("the list finds part of a title or an exact slug, and treats wildcards as text", async () => {
  const mug = await makeProduct(seller, { title: "Ceramic Mug 100% Cotton" });
  await makeProduct(seller, { title: "Steel_Bottle" });
  const found = async (q) => (await admin("GET", `/products?q=${encodeURIComponent(q)}`)).body.products.map((row) => row.title);
  assert.deepEqual(await found("RAMIC"), ["Ceramic Mug 100% Cotton"]);
  assert.deepEqual(await found(mug.slug), ["Ceramic Mug 100% Cotton"]);
  assert.deepEqual(await found("%"), ["Ceramic Mug 100% Cotton"]);
  assert.deepEqual(await found("_"), ["Steel_Bottle"]);
  assert.deepEqual(await found("\\"), []);
  assert.deepEqual(await found("'; DROP TABLE products; --"), []);
  assert.equal((await admin("GET", "/products?q=")).body.pagination.total, 2);
});

test("the list pages without repeats", async () => {
  for (let i = 0; i < 5; i += 1) await makeProduct(seller);
  const seen = [];
  for (const page of [1, 2, 3]) {
    const res = await admin("GET", `/products?limit=2&page=${page}`);
    assert.equal(res.body.pagination.total, 5);
    seen.push(...res.body.products.map((row) => row.id));
  }
  assert.equal(new Set(seen).size, 5);
});

test("bad list filters get a 400", async () => {
  for (const query of ["status=live", "blocked=maybe", "sellerId=abc", "limit=101", "page=0", "q=a%00b"]) {
    assert.equal((await admin("GET", `/products?${query}`)).status, 400, query);
  }
});

test("the admin product page shows hidden products, with inactive variants and all images", async () => {
  const product = await makeProduct(seller, { status: "draft" });
  await db.query(
    `INSERT INTO product_variants (product_id, seller_id, sku, mrp, selling_price, is_active, options)
     VALUES ($1, $2, 'OFF', 100, 100, FALSE, '{"a":"1"}')`,
    [product.id, seller.id]
  );
  const { status, body } = await admin("GET", `/products/${product.id}`);
  assert.equal(status, 200);
  assert.equal(body.product.status, "draft");
  assert.equal(body.product.variants.length, 2);
  assert.equal(body.product.images.length, 1);
  assert.equal(body.product.variants[0].stockQuantity, 5);
  assert.equal(await isPublic(product), false);
});

// ---------- Text Postgres can't store ----------

test("a NUL character in text is a 400, not a server error", async () => {
  const product = await makeProduct(seller);
  assert.equal((await block(product.id, "bad\u0000reason")).status, 400);
  const jsonb = await api("PATCH", `/seller/products/${product.id}`, {
    token: seller.token,
    body: { specifications: { RAM: "8\u0000GB" } },
  });
  assert.equal(jsonb.status, 400);
  assert.equal(await isPublic(product), true);
});
