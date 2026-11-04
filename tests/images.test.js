// End-to-end tests of image uploads, using an in-memory fake instead of real storage.
// tests/storage.test.js covers the real S3 and R2 code.

const { after, before, beforeEach, test } = require("node:test");
const assert = require("node:assert/strict");

require("./testEnv");

const app = require("../src/app");
const db = require("../src/config/db");
const env = require("../src/config/env");
const limiters = require("../src/middlewares/rateLimit");
const storage = require("../src/services/storage");
const { signAccessToken } = require("../src/utils/token");

let server;
let baseUrl;
let sellerToken;
let sellerId;
let otherToken;
let otherId;
let adminToken;
let category;
let fake;

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
const WEBP = Buffer.from("RIFF\0\0\0\0WEBP", "latin1");
const HTML = Buffer.from("<script>xss</script>");

function makeFakeDriver(provider = "r2") {
  const files = new Map();
  return {
    provider,
    files,
    uploadUrlSeconds: 300,
    removed: [],
    publicUrlFor: (key) => `https://cdn.test/${key}`,
    createUploadUrl: async (key, contentType) => `https://storage.test/${key}?type=${contentType}`,
    inspect: async (key) => files.get(key) ?? null,
    async remove(key) {
      this.removed.push(key);
      files.delete(key);
    },
  };
}

const logged = console.log;
const loggedError = console.error;
before(async () => {
  console.log = () => {};
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}/api`;
});

after(async () => {
  console.log = logged;
  console.error = loggedError;
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

async function makeSeller() {
  const user = await makeUser("seller");
  const { rows } = await db.query(
    `INSERT INTO seller_profiles (user_id, store_name, store_slug, legal_business_name, verification_status)
     VALUES ($1, 'Store', $2, 'Legal', 'approved') RETURNING id`,
    [user.id, `store-${counter}`]
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

beforeEach(async () => {
  await db.query("TRUNCATE users, categories, brands, variant_options CASCADE");
  for (const limiter of Object.values(limiters)) limiter.resetKey("127.0.0.1");
  ({ token: sellerToken, id: sellerId } = await makeSeller());
  ({ token: otherToken, id: otherId } = await makeSeller());
  adminToken = signAccessToken(await makeUser("admin"));
  category = (
    await db.query("INSERT INTO categories (name, slug) VALUES ('Mugs', 'mugs') RETURNING *")
  ).rows[0];
  fake = makeFakeDriver();
  storage.drivers.r2 = fake;
  delete storage.drivers.s3;
  env.STORAGE_DRIVER = "r2";
  console.error = () => {};
});

async function makeProduct(token = sellerToken) {
  const res = await seller("POST", "/products", { categoryId: category.id, title: "Mug" }, token);
  assert.equal(res.status, 201);
  return res.body.product;
}

// Plays the browser's part: asks for a URL, then "uploads" the file into the fake.
async function upload({ bytes = PNG, contentType = "image/png", sizeBytes, token = sellerToken } = {}) {
  const res = await seller("POST", "/uploads/signature", { contentType: "image/png", sizeBytes: 1000 }, token);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const key = res.body.upload.storageKey;
  fake.files.set(key, { sizeBytes: sizeBytes ?? bytes.length, contentType, firstBytes: bytes.subarray(0, 12) });
  return key;
}

async function attach(productId, extra = {}, token = sellerToken) {
  const storageKey = await upload({ token });
  const res = await seller("POST", `/products/${productId}/images`, { storageKey, ...extra }, token);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.image;
}

async function publishDirectly(productId) {
  await db.query(
    `UPDATE products SET status = 'active', generic_name = 'Mug', country_of_origin = 'IN',
       manufacturer_name = 'M', manufacturer_address = 'A' WHERE id = $1`,
    [productId]
  );
}

const MISSING_ID = "01a1a678-51f8-7872-8d63-9863d5ebdfad";

test("image routes refuse visitors and non-sellers", async () => {
  const customer = signAccessToken(await makeUser("customer"));
  for (const [method, path] of [
    ["POST", "/seller/uploads/signature"],
    ["POST", `/seller/products/${MISSING_ID}/images`],
    ["PATCH", `/seller/images/${MISSING_ID}`],
    ["DELETE", `/seller/images/${MISSING_ID}`],
    ["POST", "/admin/uploads/signature"],
  ]) {
    assert.equal((await api(method, path)).status, 401, path);
    assert.equal((await api(method, path, { token: customer })).status, 403, path);
  }
  assert.equal((await api("POST", "/admin/uploads/signature", { token: sellerToken })).status, 403);
});

test("with no storage set up, uploads return 503 and the rest of the API still works", async () => {
  env.STORAGE_DRIVER = undefined;
  const signature = await seller("POST", "/uploads/signature", { contentType: "image/png", sizeBytes: 1 });
  assert.equal(signature.status, 503);
  assert.equal(signature.body.code, "STORAGE_NOT_CONFIGURED");

  const product = await makeProduct();
  const attached = await seller("POST", `/products/${product.id}/images`, { storageKey: "products/x/y.png" });
  assert.equal(attached.status, 503);
  assert.equal((await seller("GET", `/products/${product.id}`)).status, 200);
  assert.equal((await api("GET", "/health")).status, 200);
});

test("an upload URL is issued for the seller's own folder, with the right extension", async () => {
  for (const [contentType, extension] of [["image/jpeg", "jpg"], ["image/png", "png"], ["image/webp", "webp"]]) {
    const res = await seller("POST", "/uploads/signature", { contentType, sizeBytes: 1000 });
    assert.equal(res.status, 201);
    const { upload: u } = res.body;
    assert.match(u.storageKey, new RegExp(`^products/${sellerId}/[0-9a-f-]{36}\\.${extension}$`));
    assert.equal(u.method, "PUT");
    assert.deepEqual(u.headers, { "Content-Type": contentType });
    assert.equal(u.expiresInSeconds, 300);
    assert.equal(u.maxSizeBytes, 5242880);
    assert.equal(u.publicUrl, `https://cdn.test/${u.storageKey}`);
  }
});

test("upload URLs refuse other file types and oversized files", async () => {
  const sign = (body) => seller("POST", "/uploads/signature", body);
  for (const bad of [
    {},
    { contentType: "image/png" },
    { contentType: "image/svg+xml", sizeBytes: 100 },
    { contentType: "text/html", sizeBytes: 100 },
    { contentType: "image/png", sizeBytes: 0 },
    { contentType: "image/png", sizeBytes: 5242881 },
    { contentType: "image/png", sizeBytes: 1, storageKey: "products/x/y.png" },
  ]) {
    assert.equal((await sign(bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await sign({ contentType: "image/png", sizeBytes: 5242880 })).status, 201);
});

test("a good upload attaches, and the first image becomes primary", async () => {
  const product = await makeProduct();
  const key = await upload();
  const res = await seller("POST", `/products/${product.id}/images`, { storageKey: key, altText: "Front" });
  assert.equal(res.status, 201);
  assert.equal(res.body.image.url, `https://cdn.test/${key}`);
  assert.equal(res.body.image.altText, "Front");
  assert.equal(res.body.image.isPrimary, true);

  const second = await attach(product.id);
  assert.equal(second.isPrimary, false);
  assert.equal(second.sortOrder, 1);

  const { rows } = await db.query("SELECT storage_provider, storage_key FROM product_images WHERE id = $1", [res.body.image.id]);
  assert.deepEqual(rows[0], { storage_provider: "r2", storage_key: key });
});

test("every allowed image type is recognised from its real bytes", async () => {
  const product = await makeProduct();
  for (const [bytes, contentType] of [[PNG, "image/png"], [JPEG, "image/jpeg"], [WEBP, "image/webp"]]) {
    const key = await upload({ bytes, contentType });
    assert.equal((await seller("POST", `/products/${product.id}/images`, { storageKey: key })).status, 201, contentType);
  }
});

test("a file that fails the checks is refused and deleted", async () => {
  const product = await makeProduct();
  const cases = [
    ["too large", { sizeBytes: 5242881 }, /5 MB/],
    ["empty", { bytes: Buffer.alloc(0), sizeBytes: 0 }, /5 MB/],
    ["HTML declared as PNG", { bytes: HTML }, /valid image/],
    ["JPEG declared as PNG", { bytes: JPEG }, /valid image/],
    ["HTML type", { bytes: HTML, contentType: "text/html" }, /JPEG, PNG and WebP/],
    ["SVG type", { bytes: PNG, contentType: "image/svg+xml" }, /JPEG, PNG and WebP/],
  ];
  for (const [label, file, message] of cases) {
    const key = await upload(file);
    const res = await seller("POST", `/products/${product.id}/images`, { storageKey: key });
    assert.equal(res.status, 400, label);
    assert.equal(res.body.code, "INVALID_UPLOAD", label);
    assert.match(res.body.message, message, label);
    assert.ok(fake.removed.includes(key), `${label} should be deleted`);
  }
  assert.equal((await seller("GET", `/products/${product.id}`)).body.product.images.length, 0);
});

test("a seller can't attach another seller's file or a made-up path", async () => {
  const product = await makeProduct();
  const theirKey = await upload({ token: otherToken });
  const steal = await seller("POST", `/products/${product.id}/images`, { storageKey: theirKey });
  assert.equal(steal.body.code, "INVALID_UPLOAD");
  assert.ok(fake.files.has(theirKey), "someone else's file must not be deleted");

  for (const storageKey of [
    "categories/x.png",
    `products/${otherId}/x.png`,
    `products/${sellerId}x/y.png`,
  ]) {
    const res = await seller("POST", `/products/${product.id}/images`, { storageKey });
    assert.equal(res.body.code, "INVALID_UPLOAD", storageKey);
  }
  const missing = await seller("POST", `/products/${product.id}/images`, { storageKey: `products/${sellerId}/none.png` });
  assert.equal(missing.status, 400);
  assert.equal(missing.body.code, "UPLOAD_NOT_FOUND");
  assert.equal((await seller("POST", `/products/${product.id}/images`, {})).status, 400);
});

test("a file can only be attached once", async () => {
  const product = await makeProduct();
  const other = await makeProduct();
  const key = await upload();
  assert.equal((await seller("POST", `/products/${product.id}/images`, { storageKey: key })).status, 201);
  const again = await seller("POST", `/products/${other.id}/images`, { storageKey: key });
  assert.equal(again.status, 409);
  assert.match(again.body.message, /already attached/);
});

test("another seller's product and images are out of reach", async () => {
  const product = await makeProduct();
  const image = await attach(product.id);
  const theirKey = await upload({ token: otherToken });
  assert.equal((await seller("POST", `/products/${product.id}/images`, { storageKey: theirKey }, otherToken)).status, 404);
  assert.equal((await seller("PATCH", `/images/${image.id}`, { altText: "x" }, otherToken)).status, 404);
  assert.equal((await seller("DELETE", `/images/${image.id}`, undefined, otherToken)).status, 404);
  assert.equal((await seller("POST", `/products/${MISSING_ID}/images`, { storageKey: theirKey })).status, 404);
});

test("a product can have at most 8 images, even in parallel", async () => {
  const product = await makeProduct();
  const keys = [];
  for (let i = 0; i < 12; i++) keys.push(await upload());
  const results = await Promise.all(keys.map((storageKey) => seller("POST", `/products/${product.id}/images`, { storageKey })));
  assert.equal(results.filter((r) => r.status === 201).length, 8);
  const refused = results.filter((r) => r.status === 400);
  assert.equal(refused.length, 4);
  assert.equal(refused[0].body.code, "IMAGE_LIMIT_REACHED");
  const { rows } = await db.query("SELECT COUNT(*) FILTER (WHERE is_primary)::int AS primaries FROM product_images");
  assert.equal(rows[0].primaries, 1);
});

test("images can be tied to a variant on the same product only", async () => {
  const product = await makeProduct();
  const variant = (await seller("POST", `/products/${product.id}/variants`, { sku: "A", mrp: 10, sellingPrice: 5 })).body.variant;
  const elsewhere = await makeProduct();
  const theirVariant = (await seller("POST", `/products/${elsewhere.id}/variants`, { sku: "B", mrp: 10, sellingPrice: 5 })).body.variant;

  const tied = await attach(product.id, { variantId: variant.id });
  assert.equal(tied.variantId, variant.id);

  const key = await upload();
  const wrong = await seller("POST", `/products/${product.id}/images`, { storageKey: key, variantId: theirVariant.id });
  assert.equal(wrong.body.code, "INVALID_VARIANT");

  assert.equal((await seller("PATCH", `/images/${tied.id}`, { variantId: theirVariant.id })).body.code, "INVALID_VARIANT");
  const cleared = await seller("PATCH", `/images/${tied.id}`, { variantId: null });
  assert.equal(cleared.body.image.variantId, null);

  await seller("PATCH", `/images/${tied.id}`, { variantId: variant.id });
  await seller("DELETE", `/variants/${variant.id}`);
  const fetched = await seller("GET", `/products/${product.id}`);
  assert.equal(fetched.body.product.images[0].variantId, null);
});

test("edits apply, and making an image primary moves the flag", async () => {
  const product = await makeProduct();
  const first = await attach(product.id);
  const second = await attach(product.id);

  const edited = await seller("PATCH", `/images/${second.id}`, { altText: "Back", sortOrder: 5 });
  assert.equal(edited.body.image.altText, "Back");
  assert.equal(edited.body.image.sortOrder, 5);
  assert.equal((await seller("PATCH", `/images/${second.id}`, { altText: null })).body.image.altText, null);

  const primary = await seller("PATCH", `/images/${second.id}`, { isPrimary: true });
  assert.equal(primary.body.image.isPrimary, true);
  const { images } = (await seller("GET", `/products/${product.id}`)).body.product;
  assert.deepEqual(images.map((i) => [i.id, i.isPrimary]), [[second.id, true], [first.id, false]]);

  for (const bad of [{}, { isPrimary: false }, { url: "https://evil.test/x.png" }, { storageKey: "x" }, { sortOrder: -1 }]) {
    assert.equal((await seller("PATCH", `/images/${first.id}`, bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await seller("PATCH", `/images/${MISSING_ID}`, { altText: "x" })).status, 404);
});

test("parallel changes leave exactly one primary image", async () => {
  const product = await makeProduct();
  const images = [await attach(product.id), await attach(product.id), await attach(product.id)];
  const results = await Promise.all(images.map((i) => seller("PATCH", `/images/${i.id}`, { isPrimary: true })));
  assert.ok(results.every((r) => r.status === 200));
  const { rows } = await db.query("SELECT COUNT(*)::int AS n FROM product_images WHERE is_primary");
  assert.equal(rows[0].n, 1);
});

test("deleting an image removes the file, and the next image becomes primary", async () => {
  const product = await makeProduct();
  const first = await attach(product.id);
  const second = await attach(product.id);
  const key = (await db.query("SELECT storage_key FROM product_images WHERE id = $1", [first.id])).rows[0].storage_key;

  assert.equal((await seller("DELETE", `/images/${first.id}`)).status, 204);
  assert.ok(fake.removed.includes(key));
  assert.equal((await seller("DELETE", `/images/${first.id}`)).status, 404);

  const { images } = (await seller("GET", `/products/${product.id}`)).body.product;
  assert.deepEqual(images.map((i) => [i.id, i.isPrimary]), [[second.id, true]]);
  assert.equal((await seller("DELETE", `/images/${second.id}`)).status, 204);
});

test("a published product must keep an image", async () => {
  const product = await makeProduct();
  const first = await attach(product.id);
  const second = await attach(product.id);
  await publishDirectly(product.id);
  assert.equal((await seller("DELETE", `/images/${first.id}`)).status, 204);
  const last = await seller("DELETE", `/images/${second.id}`);
  assert.equal(last.status, 409);
  assert.equal(last.body.code, "LAST_IMAGE");
});

test("if storage fails on delete, the image is still removed and the failure logged", async () => {
  const product = await makeProduct();
  const image = await attach(product.id);
  fake.remove = async () => {
    throw new Error("network down");
  };
  assert.equal((await seller("DELETE", `/images/${image.id}`)).status, 204);
  assert.equal((await seller("GET", `/products/${product.id}`)).body.product.images.length, 0);
});

test("if storage fails while checking an upload, the seller gets a clear error", async () => {
  const product = await makeProduct();
  const key = await upload();
  const ApiError = require("../src/utils/ApiError");
  fake.inspect = async () => {
    throw new ApiError(502, "File storage is unavailable. Try again shortly", { code: "STORAGE_ERROR" });
  };
  const res = await seller("POST", `/products/${product.id}/images`, { storageKey: key });
  assert.equal(res.status, 502);
  assert.equal(res.body.code, "STORAGE_ERROR");
});

test("after switching provider, old images still delete from where they are", async () => {
  const product = await makeProduct();
  const oldImage = await attach(product.id);
  const oldKey = (await db.query("SELECT storage_key FROM product_images WHERE id = $1", [oldImage.id])).rows[0].storage_key;
  const r2 = fake;

  const s3 = makeFakeDriver("s3");
  storage.drivers.s3 = s3;
  env.STORAGE_DRIVER = "s3";
  fake = s3;
  const newImage = await attach(product.id);
  const { rows } = await db.query("SELECT storage_provider FROM product_images WHERE id = $1", [newImage.id]);
  assert.equal(rows[0].storage_provider, "s3");

  assert.equal((await seller("DELETE", `/images/${oldImage.id}`)).status, 204);
  assert.ok(r2.removed.includes(oldKey), "deleted from R2, where it was stored");
  assert.equal(s3.removed.length, 0);
});

test("deleting works even if the old provider's settings are gone", async () => {
  const product = await makeProduct();
  const image = await attach(product.id);
  await attach(product.id);
  delete storage.drivers.r2;
  assert.equal((await seller("DELETE", `/images/${image.id}`)).status, 204);
});

test("product responses include images, and lists include the primary image", async () => {
  const product = await makeProduct();
  const image = await attach(product.id);
  const updated = await seller("PATCH", `/products/${product.id}`, { title: "New" });
  assert.equal(updated.body.product.images[0].id, image.id);
  assert.equal(updated.body.product.images[0].storageKey, undefined);

  const list = await seller("GET", "/products");
  assert.equal(list.body.products[0].primaryImageUrl, image.url);
});

test("a suspended seller can't upload or change images", async () => {
  const product = await makeProduct();
  const image = await attach(product.id);
  await db.query("UPDATE seller_profiles SET verification_status = 'suspended' WHERE id = $1", [sellerId]);
  for (const [method, path, body] of [
    ["POST", "/uploads/signature", { contentType: "image/png", sizeBytes: 1 }],
    ["POST", `/products/${product.id}/images`, { storageKey: "x" }],
    ["PATCH", `/images/${image.id}`, { altText: "x" }],
    ["DELETE", `/images/${image.id}`],
  ]) {
    const res = await seller(method, path, body);
    assert.equal(res.status, 403, path);
    assert.equal(res.body.code, "PROFILE_SUSPENDED");
  }
});

test("admins get upload URLs for category images and brand logos", async () => {
  const sign = (body) => api("POST", "/admin/uploads/signature", { token: adminToken, body });
  const forCategory = await sign({ contentType: "image/webp", sizeBytes: 100, purpose: "category" });
  assert.equal(forCategory.status, 201);
  assert.match(forCategory.body.upload.storageKey, /^categories\/[0-9a-f-]{36}\.webp$/);
  const forBrand = await sign({ contentType: "image/png", sizeBytes: 100, purpose: "brand" });
  assert.match(forBrand.body.upload.storageKey, /^brands\/[0-9a-f-]{36}\.png$/);

  assert.equal((await sign({ contentType: "image/png", sizeBytes: 100 })).status, 400);
  assert.equal((await sign({ contentType: "image/png", sizeBytes: 100, purpose: "other" })).status, 400);

  const saved = await api("PATCH", `/admin/categories/${category.id}`, {
    token: adminToken,
    body: { imageUrl: forCategory.body.upload.publicUrl },
  });
  assert.equal(saved.body.category.imageUrl, forCategory.body.upload.publicUrl);
});

test("upload URLs are rate limited, because files cost money", async () => {
  const body = { contentType: "image/png", sizeBytes: 1 };
  for (let i = 0; i < 300; i++) assert.equal((await seller("POST", "/uploads/signature", body)).status, 201);
  const limited = await seller("POST", "/uploads/signature", body);
  assert.equal(limited.status, 429);
  assert.equal(limited.body.code, "RATE_LIMITED");
});
