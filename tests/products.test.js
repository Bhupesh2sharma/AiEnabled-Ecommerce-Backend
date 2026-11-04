// End-to-end tests of sellers' product and variant APIs against a real Postgres.
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
let adminToken;
let sellerToken;
let sellerProfileId;
let otherToken;
let category;

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
  return { token: signAccessToken(user), profileId: rows[0].id };
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

async function makeCategory(name, parentId) {
  const res = await admin("POST", "/categories", { name, parentId });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.category;
}

// Clothing uses a required Size (fixed list) and a required Colour (sellers can type their own).
async function clothingCategory() {
  const clothing = await makeCategory("Clothing");
  const size = (await admin("POST", "/variant-options", { name: "Size" })).body.option;
  for (const [label, code] of [["Small", "s"], ["Medium", "m"], ["Large", "l"]]) {
    await admin("POST", `/variant-options/${size.id}/values`, { label, code });
  }
  const colour = (await admin("POST", "/variant-options", { name: "Colour", allowCustomValues: true })).body.option;
  await admin("POST", `/variant-options/${colour.id}/values`, { label: "Red", code: "red" });
  const res = await admin("PUT", `/categories/${clothing.id}/variant-options`, {
    options: [{ optionId: size.id }, { optionId: colour.id }],
  });
  assert.equal(res.status, 200);
  return { clothing, size, colour };
}

const makeProduct = async (body = {}, token = sellerToken) => {
  const res = await seller("POST", "/products", { categoryId: category.id, title: "Plain Mug", ...body }, token);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.product;
};

const variantBody = (extra = {}) => ({ sku: "SKU-1", mrp: 999, sellingPrice: 499, ...extra });

const makeVariant = async (productId, extra = {}, token = sellerToken) => {
  const res = await seller("POST", `/products/${productId}/variants`, variantBody(extra), token);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.variant;
};

// Publishing arrives in step 7, so this sets a product live directly.
async function publishDirectly(productId) {
  await db.query(
    `UPDATE products SET status = 'active', generic_name = 'Mug', country_of_origin = 'IN',
       manufacturer_name = 'M', manufacturer_address = 'A' WHERE id = $1`,
    [productId]
  );
}

const MISSING_ID = "01a1a678-51f8-7872-8d63-9863d5ebdfad";

beforeEach(async () => {
  await db.query("TRUNCATE users, categories, brands, variant_options CASCADE");
  for (const limiter of Object.values(limiters)) limiter.resetKey("127.0.0.1");
  adminToken = signAccessToken(await makeUser("admin"));
  ({ token: sellerToken, profileId: sellerProfileId } = await makeSeller());
  ({ token: otherToken } = await makeSeller());
  category = await makeCategory("Mugs");
});

test("product routes refuse visitors, non-sellers and sellers with no store", async () => {
  const customer = signAccessToken(await makeUser("customer"));
  const noStore = signAccessToken(await makeUser("seller"));
  const routes = [
    ["POST", "/products"],
    ["GET", "/products"],
    ["GET", `/products/${MISSING_ID}`],
    ["PATCH", `/products/${MISSING_ID}`],
    ["DELETE", `/products/${MISSING_ID}`],
    ["POST", `/products/${MISSING_ID}/variants`],
    ["PATCH", `/variants/${MISSING_ID}`],
    ["DELETE", `/variants/${MISSING_ID}`],
  ];
  for (const [method, path] of routes) {
    assert.equal((await api(method, `/seller${path}`)).status, 401, `${method} ${path}`);
    assert.equal((await seller(method, path, undefined, customer)).status, 403, `${method} ${path}`);
    const res = await seller(method, path, undefined, noStore);
    assert.equal(res.status, 403, `${method} ${path}`);
    assert.equal(res.body.code, "SELLER_PROFILE_REQUIRED");
  }
});

test("a seller creates a draft with a unique URL and safe defaults", async () => {
  const product = await makeProduct({ title: "Men's Cotton T-Shirt", highlights: ["Soft"], specifications: { Material: "Cotton" } });
  assert.equal(product.status, "draft");
  assert.match(product.slug, /^men-s-cotton-t-shirt-[0-9a-f]{8}$/);
  assert.deepEqual(product.highlights, ["Soft"]);
  assert.deepEqual(product.specifications, { Material: "Cotton" });
  assert.equal(product.isReturnable, true);
  assert.equal(product.returnWindowDays, 7);
  assert.equal(product.minPrice, null);
  assert.deepEqual(product.variants, []);

  const twin = await makeProduct({ title: "Men's Cotton T-Shirt" }, otherToken);
  assert.notEqual(twin.slug, product.slug);

  const hindi = await makeProduct({ title: "कपड़े" });
  assert.match(hindi.slug, /^product-[0-9a-f]{8}$/);
});

test("sellers can't set status, URL, price summary or moderation fields", async () => {
  for (const field of [{ status: "active" }, { slug: "x" }, { minPrice: 1 }, { blockedAt: null }, { sellerId: MISSING_ID }]) {
    const res = await seller("POST", "/products", { categoryId: category.id, title: "T", ...field });
    assert.equal(res.status, 400, JSON.stringify(field));
  }
  const product = await makeProduct();
  for (const field of [{ status: "active" }, { slug: "x" }, { minPrice: 1 }, { sellerId: MISSING_ID }]) {
    assert.equal((await seller("PATCH", `/products/${product.id}`, field)).status, 400, JSON.stringify(field));
  }
  const fetched = await seller("GET", `/products/${product.id}`);
  assert.equal(fetched.body.product.status, "draft");
});

test("product creation validates its fields", async () => {
  const body = { categoryId: category.id, title: "T" };
  for (const bad of [
    { title: " " },
    { title: undefined },
    { categoryId: "nope" },
    { hsnCode: "123" },
    { countryOfOrigin: "India" },
    { returnWindowDays: 0 },
    { returnWindowDays: null },
    { highlights: "not a list" },
    { specifications: ["not", "an", "object"] },
  ]) {
    assert.equal((await seller("POST", "/products", { ...body, ...bad })).status, 400, JSON.stringify(bad));
  }
  const fine = await seller("POST", "/products", { ...body, countryOfOrigin: "in", isReturnable: false, returnWindowDays: null });
  assert.equal(fine.status, 201);
  assert.equal(fine.body.product.countryOfOrigin, "IN");
});

test("products go only on an active category with no children", async () => {
  const create = (categoryId) => seller("POST", "/products", { categoryId, title: "T" });
  assert.equal((await create(MISSING_ID)).body.code, "INVALID_CATEGORY");

  const parent = await makeCategory("Parent");
  const child = await makeCategory("Child", parent.id);
  assert.equal((await create(parent.id)).body.code, "CATEGORY_NOT_LEAF");
  assert.equal((await create(child.id)).status, 201);

  await admin("PATCH", `/categories/${parent.id}`, { isActive: false });
  assert.equal((await create(child.id)).body.code, "INVALID_CATEGORY");
});

test("a product and a sub-category can't land on one category in a race", async () => {
  for (let round = 0; round < 15; round++) {
    const leaf = await makeCategory(`Leaf ${round}`);
    const [product, child] = await Promise.all([
      seller("POST", "/products", { categoryId: leaf.id, title: "T" }),
      admin("POST", "/categories", { name: `Child ${round}`, parentId: leaf.id }),
    ]);
    const statuses = [product.status, child.status];
    assert.equal(statuses.filter((s) => s === 201).length, 1, `round ${round}: ${statuses}`);
  }
});

test("typing a brand reuses a match or creates it, and an inactive brand is refused", async () => {
  const first = await makeProduct({ brandName: "Tata Motors" });
  const second = await makeProduct({ brandName: "TATA motors" }, otherToken);
  assert.ok(first.brandId);
  assert.equal(second.brandId, first.brandId);

  const list = await api("GET", "/brands");
  assert.deepEqual(list.body.brands.map((b) => [b.name, b.slug]), [["Tata Motors", "tata-motors"]]);

  await makeProduct({ brandName: "Tata Motors!" });
  assert.equal((await api("GET", "/brands")).body.pagination.total, 2);
  await makeProduct({ brandName: "कपड़ा" });

  await admin("PATCH", `/brands/${first.brandId}`, { isActive: false });
  const refused = await seller("POST", "/products", { categoryId: category.id, title: "T", brandName: "tata motors" });
  assert.equal(refused.body.code, "BRAND_INACTIVE");

  const cleared = await seller("PATCH", `/products/${first.id}`, { brandName: null });
  assert.equal(cleared.body.product.brandId, null);
});

test("parallel sellers adding one new brand share it", async () => {
  const results = await Promise.all(
    [1, 2, 3, 4, 5].map(() => seller("POST", "/products", { categoryId: category.id, title: "T", brandName: "New Brand" }))
  );
  assert.deepEqual(results.map((r) => r.status), [201, 201, 201, 201, 201]);
  assert.equal(new Set(results.map((r) => r.body.product.brandId)).size, 1);
});

test("a seller only ever sees and changes their own products and variants", async () => {
  const product = await makeProduct();
  const variant = await makeVariant(product.id);

  assert.equal((await seller("GET", `/products/${product.id}`, undefined, otherToken)).status, 404);
  assert.equal((await seller("PATCH", `/products/${product.id}`, { title: "Hacked" }, otherToken)).status, 404);
  assert.equal((await seller("DELETE", `/products/${product.id}`, undefined, otherToken)).status, 404);
  assert.equal((await seller("POST", `/products/${product.id}/variants`, variantBody({ sku: "X" }), otherToken)).status, 404);
  assert.equal((await seller("PATCH", `/variants/${variant.id}`, { mrp: 1, sellingPrice: 1 }, otherToken)).status, 404);
  assert.equal((await seller("DELETE", `/variants/${variant.id}`, undefined, otherToken)).status, 404);
  assert.equal((await seller("GET", "/products", undefined, otherToken)).body.products.length, 0);

  const fetched = await seller("GET", `/products/${product.id}`);
  assert.equal(fetched.body.product.title, "Plain Mug");
  assert.equal(fetched.body.product.variants[0].mrp, "999.00");
});

test("sellers can list products by status, with pages and variant counts", async () => {
  const a = await makeProduct({ title: "A" });
  const b = await makeProduct({ title: "B" });
  const c = await makeProduct({ title: "C" });
  await makeVariant(a.id);
  await publishDirectly(b.id);

  const all = await seller("GET", "/products");
  assert.deepEqual(all.body.products.map((p) => p.title), ["C", "B", "A"]);
  assert.equal(all.body.products[2].variantCount, 1);
  assert.deepEqual(all.body.pagination, { page: 1, limit: 50, total: 3 });

  const active = await seller("GET", "/products?status=active");
  assert.deepEqual(active.body.products.map((p) => p.id), [b.id]);

  const page = await seller("GET", "/products?limit=1&page=2");
  assert.deepEqual(page.body.products.map((p) => p.id), [b.id]);

  assert.equal((await seller("GET", "/products?status=nope")).status, 400);
  assert.equal((await seller("GET", `/products/not-a-uuid`)).status, 400);
  await seller("DELETE", `/products/${c.id}`);
  assert.equal((await seller("GET", "/products")).body.pagination.total, 2);
});

test("product edits apply, null clears, and the URL stays the same", async () => {
  const product = await makeProduct({ description: "Old" });
  const res = await seller("PATCH", `/products/${product.id}`, { title: "New", description: null, specifications: { A: "B" } });
  assert.equal(res.status, 200);
  assert.equal(res.body.product.title, "New");
  assert.equal(res.body.product.description, null);
  assert.deepEqual(res.body.product.specifications, { A: "B" });
  assert.equal(res.body.product.slug, product.slug);

  assert.equal((await seller("PATCH", `/products/${product.id}`, {})).status, 400);
  assert.equal((await seller("PATCH", `/products/${MISSING_ID}`, { title: "X" })).status, 404);
});

test("return window rules hold across edits", async () => {
  const product = await makeProduct();
  assert.equal((await seller("PATCH", `/products/${product.id}`, { returnWindowDays: null })).status, 400);
  const off = await seller("PATCH", `/products/${product.id}`, { isReturnable: false, returnWindowDays: null });
  assert.equal(off.status, 200);
  assert.equal(off.body.product.returnWindowDays, null);
  assert.equal((await seller("PATCH", `/products/${product.id}`, { isReturnable: true })).status, 400);
  const on = await seller("PATCH", `/products/${product.id}`, { isReturnable: true, returnWindowDays: 10 });
  assert.equal(on.body.product.returnWindowDays, 10);
});

test("drafts can be incomplete, but a published product keeps its legal details", async () => {
  const product = await makeProduct();
  const draft = await seller("PATCH", `/products/${product.id}`, { genericName: "Mug" });
  assert.equal(draft.status, 200);
  assert.equal((await seller("PATCH", `/products/${product.id}`, { genericName: null })).status, 200);

  await publishDirectly(product.id);
  const refused = await seller("PATCH", `/products/${product.id}`, { genericName: null, manufacturerName: null });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.code, "LEGAL_DETAILS_REQUIRED");
  assert.deepEqual(refused.body.details.map((d) => d.field), ["genericName", "manufacturerName"]);
  assert.equal((await seller("PATCH", `/products/${product.id}`, { genericName: "Cup" })).status, 200);
});

test("a variant is created with prices as exact strings, no stock and a min price", async () => {
  const product = await makeProduct();
  const variant = await makeVariant(product.id, { mrp: "999.50", sellingPrice: 499.5, netQuantity: "1 N", weightGrams: 300 });
  assert.equal(variant.mrp, "999.50");
  assert.equal(variant.sellingPrice, "499.50");
  assert.equal(variant.gstRate, "0.00");
  assert.equal(variant.stockQuantity, 0);
  assert.deepEqual(variant.options, {});
  assert.equal((await seller("GET", `/products/${product.id}`)).body.product.minPrice, "499.50");
});

test("variants refuse bad prices and stock changes", async () => {
  const product = await makeProduct();
  const post = (extra) => seller("POST", `/products/${product.id}/variants`, variantBody(extra));

  const above = await post({ sellingPrice: 1000 });
  assert.equal(above.status, 400);
  assert.equal(above.body.code, "PRICE_ABOVE_MRP");
  assert.equal((await post({ mrp: 10.1, sellingPrice: 10.09 })).status, 201);

  for (const bad of [
    { sku: "B", mrp: 0 },
    { sku: "B", sellingPrice: 0 },
    { sku: "B", mrp: -5 },
    { sku: "B", mrp: "abc" },
    { sku: "B", mrp: 10.123 },
    { sku: "B", mrp: 100000000000 },
    { sku: " " },
    { sku: "B", stockQuantity: 5 },
    { sku: "B", weightGrams: 0 },
    { sku: "B", barcode: "abc" },
    { sku: "B", gstRate: 7 },
  ]) {
    const res = await post(bad);
    assert.equal(res.status, 400, JSON.stringify(bad));
    assert.equal(res.body.code, "VALIDATION_ERROR", JSON.stringify(bad));
  }
});

test("price rules apply against stored values when only one price is edited", async () => {
  const product = await makeProduct();
  const variant = await makeVariant(product.id);
  assert.equal((await seller("PATCH", `/variants/${variant.id}`, { sellingPrice: 1000 })).body.code, "PRICE_ABOVE_MRP");
  assert.equal((await seller("PATCH", `/variants/${variant.id}`, { mrp: 100 })).body.code, "PRICE_ABOVE_MRP");
  const fine = await seller("PATCH", `/variants/${variant.id}`, { mrp: 100, sellingPrice: 99.99 });
  assert.equal(fine.body.variant.mrp, "100.00");
  assert.equal((await seller("PATCH", `/variants/${variant.id}`, { stockQuantity: 5 })).status, 400);
  assert.equal((await seller("PATCH", `/variants/${variant.id}`, {})).status, 400);
});

test("min price follows the lowest live, active variant", async () => {
  const { clothing } = await clothingCategory();
  const product = await makeProduct({ categoryId: clothing.id });
  const minPrice = async () => (await seller("GET", `/products/${product.id}`)).body.product.minPrice;

  const a = await makeVariant(product.id, { sku: "A", sellingPrice: 500, options: { size: "s", colour: "red" } });
  const b = await makeVariant(product.id, { sku: "B", sellingPrice: 300, options: { size: "m", colour: "red" } });
  assert.equal(await minPrice(), "300.00");

  await seller("PATCH", `/variants/${b.id}`, { isActive: false });
  assert.equal(await minPrice(), "500.00");
  await seller("PATCH", `/variants/${b.id}`, { isActive: true, sellingPrice: 200 });
  assert.equal(await minPrice(), "200.00");
  await seller("DELETE", `/variants/${b.id}`);
  assert.equal(await minPrice(), "500.00");
  await seller("DELETE", `/variants/${a.id}`);
  assert.equal(await minPrice(), null);
});

test("GST: without a GSTIN it must be 0; with one it must be stated", async () => {
  const product = await makeProduct();
  const refused = await seller("POST", `/products/${product.id}/variants`, variantBody({ gstRate: 18 }));
  assert.equal(refused.body.code, "GST_NOT_ALLOWED");
  const variant = await makeVariant(product.id, { gstRate: 0 });
  assert.equal((await seller("PATCH", `/variants/${variant.id}`, { gstRate: 5 })).body.code, "GST_NOT_ALLOWED");

  const registered = await makeSeller({ taxId: "22AAAAA0000A1Z5" });
  const theirs = await makeProduct({}, registered.token);
  const post = (extra) => seller("POST", `/products/${theirs.id}/variants`, variantBody(extra), registered.token);
  const missing = await post({});
  assert.equal(missing.status, 400);
  assert.equal(missing.body.details[0].field, "gstRate");
  assert.equal((await post({ sku: "R1", gstRate: 18 })).body.variant.gstRate, "18.00");
  const second = await makeProduct({}, registered.token);
  const zero = await seller("POST", `/products/${second.id}/variants`, variantBody({ sku: "R2", gstRate: 0 }), registered.token);
  assert.equal(zero.status, 201);
});

test("variant options must match the category, and values are stored as codes", async () => {
  const { clothing } = await clothingCategory();
  const product = await makeProduct({ categoryId: clothing.id });
  const post = (options, sku = "A") => seller("POST", `/products/${product.id}/variants`, variantBody({ sku, options }));

  const missing = await post({ size: "m" });
  assert.equal(missing.body.code, "INVALID_VARIANT_OPTIONS");
  assert.deepEqual(missing.body.details.map((d) => d.field), ["options.colour"]);

  const unknown = await post({ size: "m", colour: "red", ram: "8gb" });
  assert.deepEqual(unknown.body.details.map((d) => d.field), ["options.ram"]);

  const badSize = await post({ size: "XXL", colour: "red" });
  assert.deepEqual(badSize.body.details.map((d) => d.field), ["options.size"]);

  const ok = await post({ size: "M", colour: "Red" });
  assert.equal(ok.status, 201);
  assert.deepEqual(ok.body.variant.options, { size: "m", colour: "red" });
  assert.deepEqual(ok.body.variant.optionLabels, {});
});

test("sellers can type custom values only where an admin allows it", async () => {
  const { clothing } = await clothingCategory();
  const product = await makeProduct({ categoryId: clothing.id });
  const variant = await makeVariant(product.id, { options: { size: "m", colour: "Midnight Blue" } });
  assert.deepEqual(variant.options, { size: "m", colour: "midnight-blue" });
  assert.deepEqual(variant.optionLabels, { colour: "Midnight Blue" });

  const hindi = await seller("POST", `/products/${product.id}/variants`, variantBody({ sku: "H", options: { size: "m", colour: "लाल" } }));
  assert.equal(hindi.body.code, "INVALID_VARIANT_OPTIONS");
});

test("the same options or SKU can't repeat, and deleting frees them", async () => {
  const { clothing } = await clothingCategory();
  const product = await makeProduct({ categoryId: clothing.id });
  const variant = await makeVariant(product.id, { options: { size: "m", colour: "red" } });
  const post = (extra) => seller("POST", `/products/${product.id}/variants`, variantBody(extra));

  const sameOptions = await post({ sku: "B", options: { colour: "Red", size: "M" } });
  assert.equal(sameOptions.status, 409);
  assert.match(sameOptions.body.message, /these options/);

  const sameSku = await post({ sku: "sku-1", options: { size: "l", colour: "red" } });
  assert.equal(sameSku.status, 409);
  assert.match(sameSku.body.message, /SKU/);

  await seller("DELETE", `/variants/${variant.id}`);
  assert.equal((await post({ options: { size: "m", colour: "red" } })).status, 201);

  const elsewhere = await makeProduct();
  assert.equal((await seller("POST", `/products/${elsewhere.id}/variants`, variantBody({ sku: "OTHER" }))).status, 201);
  assert.equal((await seller("POST", `/products/${elsewhere.id}/variants`, variantBody({ sku: "OTHER2" }))).status, 409);
});

test("two sellers can share a SKU", async () => {
  const mine = await makeProduct();
  const theirs = await makeProduct({}, otherToken);
  await makeVariant(mine.id, { sku: "SAME" });
  await makeVariant(theirs.id, { sku: "same" }, otherToken);
});

test("a variant keeps a removed value until its options change", async () => {
  const { clothing, size } = await clothingCategory();
  const large = (await admin("GET", "/variant-options")).body.options
    .find((o) => o.code === "size")
    .values.find((v) => v.code === "l");
  const product = await makeProduct({ categoryId: clothing.id });
  const variant = await makeVariant(product.id, { options: { size: "l", colour: "Midnight Blue" } });
  await admin("DELETE", `/variant-options/${size.id}/values/${large.id}`);

  const price = await seller("PATCH", `/variants/${variant.id}`, { sellingPrice: 100 });
  assert.equal(price.status, 200);
  assert.deepEqual(price.body.variant.options, { size: "l", colour: "midnight-blue" });

  const same = await seller("PATCH", `/variants/${variant.id}`, { options: { size: "l", colour: "midnight-blue" } });
  assert.equal(same.status, 200);
  assert.deepEqual(same.body.variant.optionLabels, { colour: "Midnight Blue" });

  const newOne = await seller("POST", `/products/${product.id}/variants`, variantBody({ sku: "N", options: { size: "l", colour: "red" } }));
  assert.equal(newOne.body.code, "INVALID_VARIANT_OPTIONS");

  const changed = await seller("PATCH", `/variants/${variant.id}`, { options: { size: "m", colour: "red" } });
  assert.deepEqual(changed.body.variant.options, { size: "m", colour: "red" });
  assert.deepEqual(changed.body.variant.optionLabels, {});
  assert.equal((await seller("PATCH", `/variants/${variant.id}`, { options: { size: "l", colour: "red" } })).body.code, "INVALID_VARIANT_OPTIONS");
});

test("a product can move category only if its variants fit", async () => {
  const { clothing } = await clothingCategory();
  const other = await makeCategory("Other");
  const product = await makeProduct({ categoryId: clothing.id });

  const empty = await seller("PATCH", `/products/${product.id}`, { categoryId: other.id });
  assert.equal(empty.body.product.categoryId, other.id);
  await seller("PATCH", `/products/${product.id}`, { categoryId: clothing.id });

  await makeVariant(product.id, { options: { size: "m", colour: "red" } });
  const refused = await seller("PATCH", `/products/${product.id}`, { categoryId: other.id });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, "VARIANTS_DONT_FIT_CATEGORY");

  assert.equal((await seller("PATCH", `/products/${product.id}`, { categoryId: MISSING_ID })).body.code, "INVALID_CATEGORY");
});

test("a published product keeps its last variant; a draft can lose it", async () => {
  const draft = await makeProduct();
  const only = await makeVariant(draft.id);
  assert.equal((await seller("DELETE", `/variants/${only.id}`)).status, 204);
  assert.equal((await seller("DELETE", `/variants/${only.id}`)).status, 404);
  assert.equal((await seller("PATCH", `/variants/${only.id}`, { mrp: 5, sellingPrice: 5 })).status, 404);

  const { clothing } = await clothingCategory();
  const live = await makeProduct({ categoryId: clothing.id });
  const a = await makeVariant(live.id, { sku: "A", options: { size: "s", colour: "red" } });
  const b = await makeVariant(live.id, { sku: "B", options: { size: "m", colour: "red" } });
  await publishDirectly(live.id);
  assert.equal((await seller("DELETE", `/variants/${a.id}`)).status, 204);
  const last = await seller("DELETE", `/variants/${b.id}`);
  assert.equal(last.status, 409);
  assert.equal(last.body.code, "LAST_VARIANT");
});

test("parallel deletes can't remove a published product's last variant", async () => {
  const { clothing } = await clothingCategory();
  const live = await makeProduct({ categoryId: clothing.id });
  const a = await makeVariant(live.id, { sku: "A", options: { size: "s", colour: "red" } });
  const b = await makeVariant(live.id, { sku: "B", options: { size: "m", colour: "red" } });
  await publishDirectly(live.id);
  const results = await Promise.all([seller("DELETE", `/variants/${a.id}`), seller("DELETE", `/variants/${b.id}`)]);
  assert.deepEqual(results.map((r) => r.status).sort(), [204, 409]);
});

test("deleting a product removes its variants, frees their SKUs and hides it", async () => {
  const product = await makeProduct();
  const variant = await makeVariant(product.id, { sku: "REUSE" });
  assert.equal((await seller("DELETE", `/products/${product.id}`)).status, 204);
  assert.equal((await seller("DELETE", `/products/${product.id}`)).status, 404);
  assert.equal((await seller("GET", `/products/${product.id}`)).status, 404);
  assert.equal((await seller("PATCH", `/variants/${variant.id}`, { mrp: 5, sellingPrice: 5 })).status, 404);
  assert.equal((await seller("POST", `/products/${product.id}/variants`, variantBody({ sku: "N" }))).status, 404);

  const next = await makeProduct();
  await makeVariant(next.id, { sku: "REUSE" });

  await admin("DELETE", `/categories/${next.categoryId}`).then((r) => assert.equal(r.status, 409));
  await seller("DELETE", `/products/${next.id}`);
  assert.equal((await admin("DELETE", `/categories/${next.categoryId}`)).status, 204);
});

test("a pending seller can prepare drafts, but a suspended one can only read", async () => {
  const pending = await makeSeller({ status: "pending" });
  const rejected = await makeSeller({ status: "rejected" });
  const draft = await makeProduct({}, pending.token);
  await makeVariant(draft.id, {}, pending.token);
  await makeProduct({}, rejected.token);

  const suspended = await makeSeller({ status: "approved" });
  const product = await makeProduct({}, suspended.token);
  const variant = await makeVariant(product.id, {}, suspended.token);
  await db.query("UPDATE seller_profiles SET verification_status = 'suspended' WHERE id = $1", [suspended.profileId]);

  const t = suspended.token;
  assert.equal((await seller("GET", `/products/${product.id}`, undefined, t)).status, 200);
  assert.equal((await seller("GET", "/products", undefined, t)).status, 200);
  for (const [method, path, body] of [
    ["POST", "/products", { categoryId: category.id, title: "T" }],
    ["PATCH", `/products/${product.id}`, { title: "T" }],
    ["DELETE", `/products/${product.id}`],
    ["POST", `/products/${product.id}/variants`, variantBody({ sku: "Z" })],
    ["PATCH", `/variants/${variant.id}`, { mrp: 5, sellingPrice: 5 }],
    ["DELETE", `/variants/${variant.id}`],
  ]) {
    const res = await seller(method, path, body, t);
    assert.equal(res.status, 403, `${method} ${path}`);
    assert.equal(res.body.code, "PROFILE_SUSPENDED");
  }
});

test("a product can have at most 100 variants", async () => {
  const { clothing, colour } = await clothingCategory();
  const product = await makeProduct({ categoryId: clothing.id });
  assert.ok(colour.allowCustomValues);
  const values = Array.from({ length: 100 }, (_, i) => `('${product.id}', '${sellerProfileId}', 'V${i}', '{"n": ${i}}', 10, 5)`);
  await db.query(`INSERT INTO product_variants (product_id, seller_id, sku, options, mrp, selling_price) VALUES ${values.join(",")}`);
  const res = await seller("POST", `/products/${product.id}/variants`, variantBody({ sku: "EXTRA", options: { size: "m", colour: "red" } }));
  assert.equal(res.body.code, "VARIANT_LIMIT_REACHED");
});

test("unexpected rule breaks from the database give a 400 with no internal details", async () => {
  const handler = require("../src/middlewares/errorHandler");
  const res = {
    status(code) {
      this.code = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
  handler(Object.assign(new Error("secret constraint detail"), { code: "23514" }), {}, res, () => {});
  assert.equal(res.code, 400);
  assert.ok(!res.body.message.includes("secret"));
});
