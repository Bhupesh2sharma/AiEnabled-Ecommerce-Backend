// End-to-end tests of publishing and pausing products against a real Postgres.
// TEST_DATABASE_URL must point at a migrated, disposable database: its data is deleted.

const { after, before, beforeEach, test } = require("node:test");
const assert = require("node:assert/strict");

require("./testEnv");

const app = require("../src/app");
const db = require("../src/config/db");
const limiters = require("../src/middlewares/rateLimit");
const { signAccessToken } = require("../src/utils/token");

let server;
let baseUrl;
let sellerToken;
let sellerId;
let adminToken;
let category;

const GSTIN = "22AAAAA0000A1Z5";
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
async function makeUser(role) {
  counter += 1;
  const { rows } = await db.query(
    `INSERT INTO users (name, email, role, email_verified_at, terms_accepted_at, terms_version)
     VALUES ('Test', $1, $2, NOW(), NOW(), 'v1') RETURNING id, role`,
    [`user${counter}@example.com`, role]
  );
  return rows[0];
}

async function makeSeller({ status = "approved", taxId = null } = {}) {
  const user = await makeUser("seller");
  const { rows } = await db.query(
    `INSERT INTO seller_profiles (user_id, store_name, store_slug, legal_business_name, verification_status, tax_id, rejection_reason)
     VALUES ($1, 'Store', $2, 'Legal', $3, $4, $5) RETURNING id`,
    [user.id, `store-${counter}`, status, taxId, status === "rejected" ? "Reason" : null]
  );
  return { token: signAccessToken(user), id: rows[0].id };
}

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

const seller = (method, path, body, token = sellerToken) => api(method, `/seller${path}`, { body, token });
const admin = (method, path, body) => api(method, `/admin${path}`, { body, token: adminToken });

const LEGAL = {
  genericName: "Mug",
  countryOfOrigin: "IN",
  manufacturerName: "Maker Ltd",
  manufacturerAddress: "1 Road, Pune",
};
const VARIANT_DETAILS = { netQuantity: "1 N", weightGrams: 300, lengthMm: 100, widthMm: 100, heightMm: 100 };

async function addImage(productId) {
  counter += 1;
  await db.query(
    `INSERT INTO product_images (product_id, storage_provider, storage_key, url, is_primary)
     VALUES ($1, 'r2', $2, 'https://cdn.test/x.png',
             NOT EXISTS (SELECT 1 FROM product_images WHERE product_id = $1))`,
    [productId, `key-${counter}`]
  );
}

async function addVariant(productId, extra = {}, token = sellerToken) {
  counter += 1;
  const res = await seller(
    "POST",
    `/products/${productId}/variants`,
    { sku: `SKU-${counter}`, mrp: 999, sellingPrice: 499, ...VARIANT_DETAILS, ...extra },
    token
  );
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.variant;
}

async function makeProduct(extra = LEGAL, token = sellerToken) {
  const res = await seller("POST", "/products", { categoryId: category.id, title: "Mug", ...extra }, token);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.product;
}

// A product with everything it needs to publish.
async function readyProduct({ token = sellerToken, product = LEGAL, variant = {} } = {}) {
  const created = await makeProduct(product, token);
  const v = await addVariant(created.id, variant, token);
  await addImage(created.id);
  return { ...created, variant: v };
}

const publish = (id, token = sellerToken) => seller("POST", `/products/${id}/publish`, undefined, token);
const pause = (id, token = sellerToken) => seller("POST", `/products/${id}/pause`, undefined, token);
const statusOf = async (id) => (await db.query("SELECT status FROM products WHERE id = $1", [id])).rows[0].status;
const problemFields = (res) => res.body.details.map((d) => d.field);

const MISSING_ID = "01a1a678-51f8-7872-8d63-9863d5ebdfad";

beforeEach(async () => {
  await db.query("TRUNCATE users, categories, brands, variant_options CASCADE");
  for (const limiter of Object.values(limiters)) limiter.resetKey("127.0.0.1");
  ({ token: sellerToken, id: sellerId } = await makeSeller());
  adminToken = signAccessToken(await makeUser("admin"));
  category = (await admin("POST", "/categories", { name: "Mugs" })).body.category;
});

test("publish and pause refuse visitors, non-sellers and other sellers", async () => {
  const customer = signAccessToken(await makeUser("customer"));
  const other = await makeSeller();
  const product = await readyProduct();
  for (const path of [`/seller/products/${product.id}/publish`, `/seller/products/${product.id}/pause`]) {
    assert.equal((await api("POST", path)).status, 401);
    assert.equal((await api("POST", path, { token: customer })).status, 403);
    assert.equal((await api("POST", path, { token: other.token })).status, 404);
  }
  assert.equal((await publish(MISSING_ID)).status, 404);
  assert.equal((await pause(MISSING_ID)).status, 404);
  assert.equal((await publish("not-a-uuid")).status, 400);
  assert.equal(await statusOf(product.id), "draft");
});

test("a complete product publishes, pauses and publishes again", async () => {
  const product = await readyProduct();
  const live = await publish(product.id);
  assert.equal(live.status, 200);
  assert.equal(live.body.product.status, "active");
  assert.equal(live.body.product.variants.length, 1);
  assert.equal(live.body.product.images.length, 1);

  const paused = await pause(product.id);
  assert.equal(paused.status, 200);
  assert.equal(paused.body.product.status, "paused");

  assert.equal((await publish(product.id)).body.product.status, "active");
  assert.equal((await publish(product.id)).status, 200);
  assert.equal((await pause(product.id)).status, 200);
  assert.equal((await pause(product.id)).status, 200);
});

test("a draft can't be paused", async () => {
  const product = await readyProduct();
  const res = await pause(product.id);
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "INVALID_STATUS_CHANGE");
});

test("only an approved store can publish", async () => {
  for (const status of ["pending", "rejected", "suspended"]) {
    const s = await makeSeller({ status: "approved" });
    const product = await readyProduct({ token: s.token });
    await db.query(
      "UPDATE seller_profiles SET verification_status = $2::seller_verification_status, rejection_reason = CASE WHEN $2::text = 'rejected' THEN 'R' END WHERE id = $1",
      [s.id, status]
    );
    const res = await publish(product.id, s.token);
    assert.equal(res.status, 403, status);
    assert.equal(res.body.code, status === "suspended" ? "PROFILE_SUSPENDED" : "SELLER_NOT_APPROVED", status);
    assert.equal(await statusOf(product.id), "draft");
  }
});

test("a store back under review can pause, but not publish", async () => {
  const product = await readyProduct();
  await publish(product.id);
  await db.query("UPDATE seller_profiles SET verification_status = 'pending' WHERE id = $1", [sellerId]);
  assert.equal((await pause(product.id)).status, 200);
  assert.equal((await publish(product.id)).body.code, "SELLER_NOT_APPROVED");
});

test("publishing reports everything missing at once, then works once fixed", async () => {
  const product = await makeProduct({});
  const empty = await publish(product.id);
  assert.equal(empty.status, 400);
  assert.equal(empty.body.code, "PRODUCT_NOT_READY");
  assert.deepEqual(problemFields(empty), [
    "genericName",
    "countryOfOrigin",
    "manufacturerName",
    "manufacturerAddress",
    "variants",
    "images",
  ]);
  assert.equal(await statusOf(product.id), "draft");

  await seller("PATCH", `/products/${product.id}`, LEGAL);
  const variant = (
    await seller("POST", `/products/${product.id}/variants`, { sku: "BARE", mrp: 10, sellingPrice: 5 })
  ).body.variant;
  assert.deepEqual(problemFields(await publish(product.id)), [
    "variants.BARE.netQuantity",
    "variants.BARE.weightGrams",
    "variants.BARE.lengthMm",
    "variants.BARE.widthMm",
    "variants.BARE.heightMm",
    "images",
  ]);

  await seller("PATCH", `/variants/${variant.id}`, VARIANT_DETAILS);
  assert.deepEqual(problemFields(await publish(product.id)), ["images"]);
  await addImage(product.id);
  assert.equal((await publish(product.id)).status, 200);
});

test("only active variants need details, and at least one must be active", async () => {
  const product = await readyProduct();
  // An inactive variant with no details, which the API allows on a draft.
  await db.query(
    `INSERT INTO product_variants (product_id, seller_id, sku, options, mrp, selling_price, is_active)
     VALUES ($1, $2, 'OFF', '{"n": 1}', 10, 5, FALSE)`,
    [product.id, sellerId]
  );
  assert.equal((await publish(product.id)).status, 200);
  await pause(product.id);

  await seller("PATCH", `/variants/${product.variant.id}`, { isActive: false });
  assert.deepEqual(problemFields(await publish(product.id)), ["variants"]);
});

test("publishing checks the category is still usable", async () => {
  const product = await readyProduct();
  await admin("PATCH", `/categories/${category.id}`, { isActive: false });
  const inactive = await publish(product.id);
  assert.deepEqual(problemFields(inactive), ["categoryId"]);
  assert.match(inactive.body.details[0].message, /no longer available/);
  await admin("PATCH", `/categories/${category.id}`, { isActive: true });

  // A draft's category can't gain children through the API, so this sets up the old data directly.
  await db.query("INSERT INTO categories (name, slug, parent_id) VALUES ('Child', 'child', $1)", [category.id]);
  const parent = await publish(product.id);
  assert.deepEqual(problemFields(parent), ["categoryId"]);
  assert.match(parent.body.details[0].message, /sub-categories/);
});

test("a blocked product can't be published, whatever its state", async () => {
  const product = await readyProduct();
  await db.query("UPDATE products SET blocked_at = NOW(), blocked_reason = 'Fake brand' WHERE id = $1", [product.id]);
  const res = await publish(product.id);
  assert.equal(res.status, 403);
  assert.equal(res.body.code, "PRODUCT_BLOCKED");
  assert.match(res.body.message, /Fake brand/);
  assert.equal(await statusOf(product.id), "draft");
});

test("a store with a GSTIN needs HSN codes, one without doesn't", async () => {
  const withGstin = await makeSeller({ taxId: GSTIN });
  const needsHsn = await readyProduct({ token: withGstin.token, variant: { gstRate: 18 } });
  assert.deepEqual(problemFields(await publish(needsHsn.id, withGstin.token)), ["hsnCode"]);
  await seller("PATCH", `/products/${needsHsn.id}`, { hsnCode: "6912" }, withGstin.token);
  assert.equal((await publish(needsHsn.id, withGstin.token)).status, 200);

  const noGstin = await readyProduct();
  assert.equal((await publish(noGstin.id)).status, 200);
});

test("publishing refuses a GST rate left over from when the store had a GSTIN", async () => {
  const product = await readyProduct();
  await db.query("UPDATE product_variants SET gst_rate = 18 WHERE product_id = $1", [product.id]);
  const res = await publish(product.id);
  assert.deepEqual(problemFields(res), [`variants.${product.variant.sku}.gstRate`]);
  await seller("PATCH", `/variants/${product.variant.id}`, { gstRate: 0 });
  assert.equal((await publish(product.id)).status, 200);
});

test("a published product can't lose required details", async () => {
  const withGstin = await makeSeller({ taxId: GSTIN });
  const t = withGstin.token;
  const product = await readyProduct({ token: t, product: { ...LEGAL, hsnCode: "6912" }, variant: { gstRate: 18 } });
  assert.equal((await seller("PATCH", `/products/${product.id}`, { hsnCode: null }, t)).status, 200);
  await seller("PATCH", `/products/${product.id}`, { hsnCode: "6912" }, t);
  await publish(product.id, t);

  for (const field of ["genericName", "countryOfOrigin", "manufacturerName", "manufacturerAddress", "hsnCode"]) {
    const res = await seller("PATCH", `/products/${product.id}`, { [field]: null }, t);
    assert.equal(res.status, 400, field);
    assert.equal(res.body.code, "LEGAL_DETAILS_REQUIRED", field);
  }
  assert.equal(await statusOf(product.id), "active");
  assert.equal((await seller("PATCH", `/products/${product.id}`, { title: "New title" }, t)).status, 200);
});

test("a published product's variants must stay complete", async () => {
  const product = await readyProduct();
  await publish(product.id);
  const { id } = product.variant;

  for (const field of ["netQuantity", "weightGrams", "lengthMm", "widthMm", "heightMm"]) {
    const res = await seller("PATCH", `/variants/${id}`, { [field]: null });
    assert.equal(res.status, 400, field);
    assert.equal(res.body.code, "VARIANT_DETAILS_REQUIRED", field);
    assert.equal(res.body.details[0].field, field);
  }
  assert.equal((await seller("PATCH", `/variants/${id}`, { sellingPrice: 450 })).status, 200);

  const draft = await readyProduct();
  assert.equal((await seller("PATCH", `/variants/${draft.variant.id}`, { netQuantity: null })).status, 200);
});

test("a variant added to a published product must be complete, unless it's inactive", async () => {
  const size = (await admin("POST", "/variant-options", { name: "Size", allowCustomValues: true })).body.option;
  await admin("PUT", `/categories/${category.id}/variant-options`, { options: [{ optionId: size.id }] });
  const product = await readyProduct({ variant: { options: { size: "s" } } });
  await publish(product.id);

  const post = (body) => seller("POST", `/products/${product.id}/variants`, { mrp: 10, sellingPrice: 5, ...body });
  const bare = await post({ sku: "BARE", options: { size: "m" } });
  assert.equal(bare.status, 400);
  assert.equal(bare.body.code, "VARIANT_DETAILS_REQUIRED");
  assert.equal(bare.body.details.length, 5);

  const hidden = await post({ sku: "HIDDEN", options: { size: "l" }, isActive: false });
  assert.equal(hidden.status, 201);

  const activate = await seller("PATCH", `/variants/${hidden.body.variant.id}`, { isActive: true });
  assert.equal(activate.body.code, "VARIANT_DETAILS_REQUIRED");
  const fixed = await seller("PATCH", `/variants/${hidden.body.variant.id}`, { isActive: true, ...VARIANT_DETAILS });
  assert.equal(fixed.status, 200);
  assert.equal(fixed.body.variant.isActive, true);

  assert.equal((await post({ sku: "FULL", options: { size: "xl" }, ...VARIANT_DETAILS })).status, 201);
});

const storeWithProfile = ({ taxId = null } = {}) => makeSeller({ taxId });

test("gaining a GSTIN unpublishes all live products", async () => {
  const s = await storeWithProfile();
  const t = s.token;
  const live = await readyProduct({ token: t });
  const paused = await readyProduct({ token: t });
  const draft = await readyProduct({ token: t });
  const other = await readyProduct();
  await publish(live.id, t);
  await publish(paused.id, t);
  await pause(paused.id, t);
  await publish(other.id);

  const res = await seller("PATCH", "/profile", { taxId: GSTIN }, t);
  assert.equal(res.status, 200);
  assert.equal(res.body.productsUnpublished, 2);
  assert.equal(res.body.profile.verificationStatus, "pending");
  assert.equal(await statusOf(live.id), "draft");
  assert.equal(await statusOf(paused.id), "draft");
  assert.equal(await statusOf(draft.id), "draft");
  assert.equal(await statusOf(other.id), "active", "another seller's product is untouched");

  // Once re-approved, publishing now needs an HSN code.
  await db.query("UPDATE seller_profiles SET verification_status = 'approved' WHERE id = $1", [s.id]);
  assert.deepEqual(problemFields(await publish(live.id, t)), ["hsnCode"]);
});

test("removing a GSTIN unpublishes, and publishing then needs the GST rates fixed", async () => {
  const s = await storeWithProfile({ taxId: GSTIN });
  const t = s.token;
  const product = await readyProduct({ token: t, product: { ...LEGAL, hsnCode: "6912" }, variant: { gstRate: 18 } });
  await publish(product.id, t);

  const res = await seller("PATCH", "/profile", { taxId: null }, t);
  assert.equal(res.body.productsUnpublished, 1);
  assert.equal(await statusOf(product.id), "draft");

  await db.query("UPDATE seller_profiles SET verification_status = 'approved' WHERE id = $1", [s.id]);
  assert.deepEqual(problemFields(await publish(product.id, t)), [`variants.${product.variant.sku}.gstRate`]);
});

test("other profile edits, and replacing one GSTIN with another, leave products live", async () => {
  const s = await storeWithProfile({ taxId: GSTIN });
  const t = s.token;
  const product = await readyProduct({ token: t, product: { ...LEGAL, hsnCode: "6912" }, variant: { gstRate: 18 } });
  await publish(product.id, t);

  const name = await seller("PATCH", "/profile", { storeName: "New Name" }, t);
  assert.equal(name.body.productsUnpublished, 0);
  assert.equal(name.body.profile.verificationStatus, "approved");

  const same = await seller("PATCH", "/profile", { taxId: GSTIN }, t);
  assert.equal(same.body.productsUnpublished, 0);
  assert.equal(same.body.profile.verificationStatus, "approved");

  const replaced = await seller("PATCH", "/profile", { taxId: "27AAAAA0000A1Z5" }, t);
  assert.equal(replaced.body.productsUnpublished, 0);
  assert.equal(replaced.body.profile.verificationStatus, "pending");
  assert.equal(await statusOf(product.id), "active");
});

test("a GSTIN change and a publish at the same moment can't leave a product live on the old tax details", async () => {
  for (let round = 0; round < 15; round++) {
    const s = await storeWithProfile();
    const product = await readyProduct({ token: s.token });
    const [, profile] = await Promise.all([
      publish(product.id, s.token),
      seller("PATCH", "/profile", { taxId: GSTIN }, s.token),
    ]);
    assert.equal(profile.status, 200);
    assert.equal(await statusOf(product.id), "draft", `round ${round}`);
  }
});

test("parallel publishes and pauses end in a valid state", async () => {
  const product = await readyProduct();
  const results = await Promise.all([publish(product.id), publish(product.id), publish(product.id)]);
  assert.ok(results.every((r) => r.status === 200));
  assert.equal(await statusOf(product.id), "active");
});

test("sellers can't change status except through publish and pause", async () => {
  const product = await readyProduct();
  assert.equal((await seller("PATCH", `/products/${product.id}`, { status: "active" })).status, 400);
  assert.equal(await statusOf(product.id), "draft");
});

test("listing by status reflects publishing", async () => {
  const product = await readyProduct();
  await publish(product.id);
  const active = await seller("GET", "/products?status=active");
  assert.deepEqual(active.body.products.map((p) => p.id), [product.id]);
  assert.equal((await seller("GET", "/products?status=draft")).body.products.length, 0);
});
