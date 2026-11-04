// End-to-end tests of the category, brand and variant option APIs against a real Postgres.
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

async function makeUser(role, email) {
  const { rows } = await db.query(
    `INSERT INTO users (name, email, role, status, email_verified_at, terms_accepted_at, terms_version)
     VALUES ('Test', $1, $2, 'active', NOW(), NOW(), 'v1') RETURNING id, role`,
    [email, role]
  );
  return rows[0];
}

beforeEach(async () => {
  await db.query("TRUNCATE users, categories, brands, variant_options CASCADE");
  for (const limiter of Object.values(limiters)) limiter.resetKey("127.0.0.1");
  adminToken = signAccessToken(await makeUser("admin", "admin@example.com"));
  sellerToken = signAccessToken(await makeUser("seller", "seller@example.com"));
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

const admin = (method, path, body) => api(method, `/admin${path}`, { body, token: adminToken });

async function makeCategory(name, parentId, extra = {}) {
  const res = await admin("POST", "/categories", { name, parentId, ...extra });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.category;
}

async function makeOption(name, extra = {}) {
  const res = await admin("POST", "/variant-options", { name, ...extra });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.option;
}

async function makeValue(optionId, label, extra = {}) {
  const res = await admin("POST", `/variant-options/${optionId}/values`, { label, ...extra });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.value;
}

const assign = (categoryId, options) =>
  admin("PUT", `/categories/${categoryId}/variant-options`, { options });

// Adds a product directly, because the seller endpoints arrive in a later step.
async function addProduct(categoryId, brandId = null) {
  const user = await makeUser("seller", `s${Math.random()}@example.com`);
  const { rows } = await db.query(
    `INSERT INTO seller_profiles (user_id, store_name, store_slug, legal_business_name)
     VALUES ($1, 'S', $2, 'L') RETURNING id`,
    [user.id, `store-${user.id.replaceAll("-", "")}`]
  );
  const product = await db.query(
    `INSERT INTO products (seller_id, category_id, brand_id, title, slug) VALUES ($1, $2, $3, 'P', $4) RETURNING id`,
    [rows[0].id, categoryId, brandId, `p-${user.id.replaceAll("-", "")}`]
  );
  return product.rows[0].id;
}

const MISSING_ID = "01a1a678-51f8-7872-8d63-9863d5ebdfad";

test("every admin catalog endpoint refuses visitors and non-admins", async () => {
  const routes = [
    ["GET", "/categories"],
    ["POST", "/categories"],
    ["PATCH", `/categories/${MISSING_ID}`],
    ["DELETE", `/categories/${MISSING_ID}`],
    ["PUT", `/categories/${MISSING_ID}/variant-options`],
    ["GET", "/brands"],
    ["POST", "/brands"],
    ["PATCH", `/brands/${MISSING_ID}`],
    ["DELETE", `/brands/${MISSING_ID}`],
    ["GET", "/variant-options"],
    ["POST", "/variant-options"],
    ["PATCH", `/variant-options/${MISSING_ID}`],
    ["DELETE", `/variant-options/${MISSING_ID}`],
    ["POST", `/variant-options/${MISSING_ID}/values`],
    ["PATCH", `/variant-options/${MISSING_ID}/values/${MISSING_ID}`],
    ["DELETE", `/variant-options/${MISSING_ID}/values/${MISSING_ID}`],
  ];
  for (const [method, path] of routes) {
    assert.equal((await api(method, `/admin${path}`)).status, 401, `${method} ${path}`);
    assert.equal((await api(method, `/admin${path}`, { token: sellerToken })).status, 403, `${method} ${path}`);
  }
});

test("an admin creates a category, with a slug made from its name", async () => {
  const res = await admin("POST", "/categories", { name: "Men's T-Shirts", defaultHsnCode: "6109" });
  assert.equal(res.status, 201);
  assert.equal(res.body.category.slug, "men-s-t-shirts");
  assert.equal(res.body.category.parentId, null);
  assert.equal(res.body.category.isActive, true);
  assert.equal(res.body.category.defaultHsnCode, "6109");
});

test("category creation refuses bad input and duplicates", async () => {
  await makeCategory("Clothing");
  assert.equal((await admin("POST", "/categories", {})).status, 400);
  assert.equal((await admin("POST", "/categories", { name: "  " })).status, 400);
  assert.equal((await admin("POST", "/categories", { name: "A", slug: "Bad Slug" })).status, 400);
  assert.equal((await admin("POST", "/categories", { name: "A", defaultHsnCode: "123" })).status, 400);
  assert.equal((await admin("POST", "/categories", { name: "A", imageUrl: "javascript:alert(1)" })).status, 400);

  const noSlug = await admin("POST", "/categories", { name: "कपड़े" });
  assert.equal(noSlug.status, 400);
  assert.equal(noSlug.body.details[0].field, "slug");
  assert.equal((await admin("POST", "/categories", { name: "कपड़े", slug: "kapde" })).status, 201);

  const duplicate = await admin("POST", "/categories", { name: "CLOTHING", slug: "clothing-2" });
  assert.equal(duplicate.status, 409);
  assert.match(duplicate.body.message, /name already exists/);
  const slug = await admin("POST", "/categories", { name: "Other", slug: "clothing" });
  assert.equal(slug.status, 409);
  assert.match(slug.body.message, /URL is already taken/);
});

test("the tree is limited to 3 levels, for new categories and for moves", async () => {
  const one = await makeCategory("One");
  const two = await makeCategory("Two", one.id);
  const three = await makeCategory("Three", two.id);

  const tooDeep = await admin("POST", "/categories", { name: "Four", parentId: three.id });
  assert.equal(tooDeep.status, 400);
  assert.equal(tooDeep.body.code, "CATEGORY_TOO_DEEP");

  // Moving Two (2 levels) under another second-level category would reach 4 levels.
  const other = await makeCategory("Other");
  const otherChild = await makeCategory("Other Child", other.id);
  const move = await admin("PATCH", `/categories/${two.id}`, { parentId: otherChild.id });
  assert.equal(move.body.code, "CATEGORY_TOO_DEEP");

  const ok = await admin("PATCH", `/categories/${two.id}`, { parentId: other.id });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.category.parentId, other.id);
});

test("a category can't be moved under itself or its own descendants", async () => {
  const one = await makeCategory("One");
  const two = await makeCategory("Two", one.id);
  for (const parentId of [one.id, two.id]) {
    const res = await admin("PATCH", `/categories/${one.id}`, { parentId });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, "INVALID_PARENT");
  }
});

test("parallel moves can't create a loop", async () => {
  const a = await makeCategory("A");
  const b = await makeCategory("B");
  const results = await Promise.all([
    admin("PATCH", `/categories/${a.id}`, { parentId: b.id }),
    admin("PATCH", `/categories/${b.id}`, { parentId: a.id }),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 400]);
  const { rows } = await db.query("SELECT COUNT(*)::int AS n FROM categories WHERE parent_id IS NULL");
  assert.equal(rows[0].n, 1);
});

test("a missing parent is refused, and a category can move to the top level", async () => {
  const bad = await admin("POST", "/categories", { name: "X", parentId: MISSING_ID });
  assert.equal(bad.body.code, "INVALID_PARENT");

  const parent = await makeCategory("Parent");
  const child = await makeCategory("Child", parent.id);
  const res = await admin("PATCH", `/categories/${child.id}`, { parentId: null });
  assert.equal(res.body.category.parentId, null);
});

test("a category with products can't get sub-categories", async () => {
  const category = await makeCategory("Leaf");
  await addProduct(category.id);
  const created = await admin("POST", "/categories", { name: "Child", parentId: category.id });
  assert.equal(created.status, 409);
  assert.equal(created.body.code, "CATEGORY_HAS_PRODUCTS");

  const other = await makeCategory("Other");
  const moved = await admin("PATCH", `/categories/${other.id}`, { parentId: category.id });
  assert.equal(moved.body.code, "CATEGORY_HAS_PRODUCTS");
});

test("category delete is refused while it has children or products, and frees the name", async () => {
  const parent = await makeCategory("Parent");
  const child = await makeCategory("Child", parent.id);
  const withChild = await admin("DELETE", `/categories/${parent.id}`);
  assert.equal(withChild.status, 409);
  assert.equal(withChild.body.code, "CATEGORY_HAS_CHILDREN");

  const product = await addProduct(child.id);
  const withProduct = await admin("DELETE", `/categories/${child.id}`);
  assert.equal(withProduct.body.code, "CATEGORY_HAS_PRODUCTS");

  await db.query("UPDATE products SET deleted_at = NOW() WHERE id = $1", [product]);
  assert.equal((await admin("DELETE", `/categories/${child.id}`)).status, 204);
  assert.equal((await admin("DELETE", `/categories/${child.id}`)).status, 404);
  assert.equal((await admin("PATCH", `/categories/${child.id}`, { name: "X" })).status, 404);
  await makeCategory("Child", parent.id);
});

test("category edits apply, null clears a field, and bad edits are refused", async () => {
  const category = await makeCategory("Shoes", null, { description: "All shoes" });
  const res = await admin("PATCH", `/categories/${category.id}`, { name: "Footwear", description: null, sortOrder: 5 });
  assert.equal(res.body.category.name, "Footwear");
  assert.equal(res.body.category.description, null);
  assert.equal(res.body.category.sortOrder, 5);
  assert.equal(res.body.category.slug, "shoes");

  assert.equal((await admin("PATCH", `/categories/${category.id}`, {})).status, 400);
  assert.equal((await admin("PATCH", `/categories/${category.id}`, { name: null })).status, 400);
  assert.equal((await admin("PATCH", `/categories/${category.id}`, { unknown: 1 })).status, 400);
  assert.equal((await admin("PATCH", "/categories/not-a-uuid", { name: "X" })).status, 400);
});

test("the public tree nests categories and hides inactive branches", async () => {
  const electronics = await makeCategory("Electronics");
  const mobiles = await makeCategory("Mobiles", electronics.id);
  const phones = await makeCategory("Smartphones", mobiles.id);
  await makeCategory("Laptops", electronics.id, { isActive: false });
  const hidden = await makeCategory("Hidden");
  await makeCategory("Under Hidden", hidden.id);
  await admin("PATCH", `/categories/${hidden.id}`, { isActive: false });

  const res = await api("GET", "/categories");
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.categories.map((c) => c.name), ["Electronics"]);
  const [top] = res.body.categories;
  assert.deepEqual(top.children.map((c) => c.name), ["Mobiles"]);
  assert.equal(top.children[0].children[0].id, phones.id);
  assert.equal(top.isActive, undefined);

  const adminList = await admin("GET", "/categories");
  assert.equal(adminList.body.categories.length, 6);
});

test("categories follow sort order, then name", async () => {
  await makeCategory("Zebra", null, { sortOrder: 1 });
  await makeCategory("Apple", null, { sortOrder: 2 });
  await makeCategory("Mango", null, { sortOrder: 1 });
  const res = await api("GET", "/categories");
  assert.deepEqual(res.body.categories.map((c) => c.name), ["Mango", "Zebra", "Apple"]);
});

test("an admin manages options and values, and codes can't change", async () => {
  const option = await makeOption("Shoe Size");
  assert.equal(option.code, "shoe-size");
  assert.equal(option.allowCustomValues, false);

  const value = await makeValue(option.id, "UK 8", { sortOrder: 2 });
  assert.equal(value.code, "uk-8");
  await makeValue(option.id, "UK 7", { sortOrder: 1 });

  const renamed = await admin("PATCH", `/variant-options/${option.id}`, { name: "Size", allowCustomValues: true });
  assert.equal(renamed.body.option.name, "Size");
  assert.equal(renamed.body.option.code, "shoe-size");
  assert.equal(renamed.body.option.allowCustomValues, true);

  const relabelled = await admin("PATCH", `/variant-options/${option.id}/values/${value.id}`, { label: "UK Eight" });
  assert.equal(relabelled.body.value.label, "UK Eight");
  assert.equal(relabelled.body.value.code, "uk-8");

  assert.equal((await admin("PATCH", `/variant-options/${option.id}`, { code: "other" })).status, 400);
  assert.equal((await admin("PATCH", `/variant-options/${option.id}/values/${value.id}`, { code: "x" })).status, 400);

  const list = await admin("GET", "/variant-options");
  assert.deepEqual(list.body.options[0].values.map((v) => v.label), ["UK 7", "UK Eight"]);
});

test("options and values refuse duplicates, bad colours and missing parents", async () => {
  const option = await makeOption("Size");
  assert.equal((await admin("POST", "/variant-options", { name: "SIZE" })).status, 409);
  await makeValue(option.id, "Medium", { code: "m" });
  const duplicate = await admin("POST", `/variant-options/${option.id}/values`, { label: "M", code: "m" });
  assert.equal(duplicate.status, 409);
  assert.match(duplicate.body.message, /already has a value/);

  const other = await makeOption("Fit");
  await makeValue(other.id, "Medium", { code: "m" });

  assert.equal((await admin("POST", `/variant-options/${option.id}/values`, { label: "R", colorHex: "red" })).status, 400);
  const colour = await makeValue(option.id, "Red", { colorHex: "#ff0000" });
  assert.equal(colour.colorHex, "#FF0000");

  assert.equal((await admin("POST", `/variant-options/${MISSING_ID}/values`, { label: "X" })).status, 404);
});

test("a value can't be edited or removed through a different option", async () => {
  const size = await makeOption("Size");
  const fit = await makeOption("Fit");
  const value = await makeValue(size.id, "M");
  assert.equal((await admin("PATCH", `/variant-options/${fit.id}/values/${value.id}`, { label: "X" })).status, 404);
  assert.equal((await admin("DELETE", `/variant-options/${fit.id}/values/${value.id}`)).status, 404);
  assert.equal((await admin("DELETE", `/variant-options/${size.id}/values/${value.id}`)).status, 204);
  assert.equal((await admin("DELETE", `/variant-options/${size.id}/values/${value.id}`)).status, 404);
});

test("an option in use by a category can't be deleted until it's removed", async () => {
  const category = await makeCategory("Clothing");
  const option = await makeOption("Size");
  await assign(category.id, [{ optionId: option.id }]);

  const refused = await admin("DELETE", `/variant-options/${option.id}`);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, "OPTION_IN_USE");

  await assign(category.id, []);
  assert.equal((await admin("DELETE", `/variant-options/${option.id}`)).status, 204);
  assert.equal((await admin("DELETE", `/variant-options/${option.id}`)).status, 404);
  await makeOption("Size");
});

test("assigning options replaces the list, and refuses missing or repeated options", async () => {
  const category = await makeCategory("Clothing");
  const size = await makeOption("Size");
  const colour = await makeOption("Colour");

  const first = await assign(category.id, [
    { optionId: size.id, sortOrder: 2 },
    { optionId: colour.id, isRequired: false, sortOrder: 1 },
  ]);
  assert.equal(first.status, 200);
  assert.deepEqual(first.body.options.map((o) => [o.code, o.isRequired, o.inherited]), [
    ["colour", false, false],
    ["size", true, false],
  ]);

  const second = await assign(category.id, [{ optionId: size.id }]);
  assert.deepEqual(second.body.options.map((o) => o.code), ["size"]);

  assert.equal((await assign(category.id, [{ optionId: MISSING_ID }])).body.code, "INVALID_OPTION");
  assert.equal((await assign(category.id, [{ optionId: size.id }, { optionId: size.id }])).status, 400);
  assert.equal((await assign(MISSING_ID, [])).status, 404);

  await admin("DELETE", `/categories/${category.id}`);
  assert.equal((await assign(category.id, [])).status, 404);
});

test("a deleted option can't be assigned", async () => {
  const category = await makeCategory("Clothing");
  const option = await makeOption("Size");
  await admin("DELETE", `/variant-options/${option.id}`);
  assert.equal((await assign(category.id, [{ optionId: option.id }])).body.code, "INVALID_OPTION");
});

test("sub-categories inherit options, and the nearest setting wins", async () => {
  const clothing = await makeCategory("Clothing");
  const tees = await makeCategory("T-Shirts", clothing.id);
  const size = await makeOption("Size");
  const colour = await makeOption("Colour", { allowCustomValues: true });
  const fit = await makeOption("Fit");
  await makeValue(size.id, "Small", { code: "s", sortOrder: 1 });
  await makeValue(size.id, "Medium", { code: "m", sortOrder: 2 });
  const red = await makeValue(colour.id, "Red", { colorHex: "#FF0000" });

  await assign(clothing.id, [{ optionId: size.id }, { optionId: colour.id }]);
  await assign(tees.id, [{ optionId: fit.id, isRequired: false }, { optionId: size.id, isRequired: false }]);

  const res = await api("GET", `/categories/${tees.id}/variant-options`);
  assert.equal(res.status, 200);
  const byCode = Object.fromEntries(res.body.options.map((o) => [o.code, o]));
  assert.deepEqual(Object.keys(byCode).sort(), ["colour", "fit", "size"]);
  assert.equal(byCode.colour.inherited, true);
  assert.equal(byCode.colour.isRequired, true);
  assert.equal(byCode.colour.allowCustomValues, true);
  assert.equal(byCode.colour.values[0].id, red.id);
  assert.equal(byCode.colour.values[0].colorHex, "#FF0000");
  assert.equal(byCode.fit.inherited, false);
  assert.deepEqual(byCode.fit.values, []);
  // T-Shirts overrides Clothing's setting for Size.
  assert.equal(byCode.size.inherited, false);
  assert.equal(byCode.size.isRequired, false);
  assert.deepEqual(byCode.size.values.map((v) => v.code), ["s", "m"]);

  const parent = await api("GET", `/categories/${clothing.id}/variant-options`);
  assert.deepEqual(parent.body.options.map((o) => o.code).sort(), ["colour", "size"]);
});

test("the public options list leaves out deleted values and hidden categories", async () => {
  const parent = await makeCategory("Parent");
  const child = await makeCategory("Child", parent.id);
  const size = await makeOption("Size");
  const small = await makeValue(size.id, "Small");
  await makeValue(size.id, "Large");
  await assign(child.id, [{ optionId: size.id }]);
  await admin("DELETE", `/variant-options/${size.id}/values/${small.id}`);

  const res = await api("GET", `/categories/${child.id}/variant-options`);
  assert.deepEqual(res.body.options[0].values.map((v) => v.label), ["Large"]);

  await admin("PATCH", `/categories/${parent.id}`, { isActive: false });
  assert.equal((await api("GET", `/categories/${child.id}/variant-options`)).status, 404);
  assert.equal((await api("GET", `/categories/${MISSING_ID}/variant-options`)).status, 404);
  assert.equal((await api("GET", "/categories/not-a-uuid/variant-options")).status, 400);
});

test("an admin manages brands, and the public list shows only active ones", async () => {
  const created = await admin("POST", "/brands", { name: "Tata Motors", logoUrl: "https://cdn.example.com/t.png" });
  assert.equal(created.status, 201);
  assert.equal(created.body.brand.slug, "tata-motors");
  await admin("POST", "/brands", { name: "Amul" });
  const hidden = await admin("POST", "/brands", { name: "Hidden", isActive: false });

  const list = await api("GET", "/brands");
  assert.deepEqual(list.body.brands.map((b) => b.name), ["Amul", "Tata Motors"]);
  assert.deepEqual(list.body.pagination, { page: 1, limit: 50, total: 2 });
  assert.equal(list.body.brands[0].isActive, undefined);

  const adminList = await admin("GET", "/brands");
  assert.equal(adminList.body.pagination.total, 3);

  const edited = await admin("PATCH", `/brands/${hidden.body.brand.id}`, { isActive: true, name: "Shown" });
  assert.equal(edited.body.brand.isActive, true);
  assert.equal(edited.body.brand.name, "Shown");
  assert.equal((await admin("PATCH", `/brands/${MISSING_ID}`, { name: "X" })).status, 404);
});

test("brands refuse duplicates and bad logos, and page and search correctly", async () => {
  await admin("POST", "/brands", { name: "Nike" });
  assert.equal((await admin("POST", "/brands", { name: "NIKE" })).status, 409);
  assert.equal((await admin("POST", "/brands", { name: "X", logoUrl: "javascript:alert(1)" })).status, 400);

  for (const name of ["Nivea", "Nokia", "Puma", "100%_Pure"]) await admin("POST", "/brands", { name });

  const search = await api("GET", "/brands?q=ni");
  assert.deepEqual(search.body.brands.map((b) => b.name), ["Nike", "Nivea"]);
  assert.equal(search.body.pagination.total, 2);

  // % and _ are ordinary characters in a search, not wildcards.
  assert.equal((await api("GET", "/brands?q=%25")).body.pagination.total, 0);
  assert.deepEqual((await api("GET", "/brands?q=100%25_")).body.brands.map((b) => b.name), ["100%_Pure"]);

  const page = await api("GET", "/brands?limit=2&page=2");
  assert.deepEqual(page.body.brands.map((b) => b.name), ["Nivea", "Nokia"]);
  assert.deepEqual(page.body.pagination, { page: 2, limit: 2, total: 5 });

  assert.equal((await api("GET", "/brands?limit=101")).status, 400);
  assert.equal((await api("GET", "/brands?page=0")).status, 400);
});

test("a brand in use can't be deleted, and its name is free after deleting", async () => {
  const category = await makeCategory("Clothing");
  const brand = (await admin("POST", "/brands", { name: "Nike" })).body.brand;
  const product = await addProduct(category.id, brand.id);

  const refused = await admin("DELETE", `/brands/${brand.id}`);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, "BRAND_IN_USE");

  await db.query("UPDATE products SET deleted_at = NOW() WHERE id = $1", [product]);
  assert.equal((await admin("DELETE", `/brands/${brand.id}`)).status, 204);
  assert.equal((await admin("DELETE", `/brands/${brand.id}`)).status, 404);
  assert.equal((await admin("DELETE", `/brands/${MISSING_ID}`)).status, 404);
  assert.equal((await admin("POST", "/brands", { name: "Nike" })).status, 201);
});

test("removing an in-use record directly gives a 409, not a 500", async () => {
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
  for (const code of ["23001", "23503"]) {
    handler(Object.assign(new Error("secret table detail"), { code }), {}, res, () => {});
    assert.equal(res.code, 409);
    assert.ok(!res.body.message.includes("secret"));
  }
});

test("public catalog requests are rate limited, separately from health", async () => {
  for (let i = 0; i < 300; i++) assert.equal((await api("GET", "/brands?limit=1")).status, 200);
  const limited = await api("GET", "/categories");
  assert.equal(limited.status, 429);
  assert.equal(limited.body.code, "RATE_LIMITED");
  assert.equal((await api("GET", "/health")).status, 200);
});

test("seller store URLs refuse javascript links", async () => {
  const { updateProfile } = require("../src/validators/seller.validator");
  assert.equal(updateProfile.safeParse({ logoUrl: "javascript:alert(1)" }).success, false);
  assert.equal(updateProfile.safeParse({ logoUrl: "https://cdn.example.com/a.png" }).success, true);
});
