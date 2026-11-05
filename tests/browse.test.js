// End-to-end tests of public product browsing against a real Postgres.
// TEST_DATABASE_URL must point at a migrated, disposable database: its data is deleted.

const { after, before, beforeEach, test } = require("node:test");
const assert = require("node:assert/strict");

require("./testEnv");

const app = require("../src/app");
const db = require("../src/config/db");
const limiters = require("../src/middlewares/rateLimit");

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

async function get(path) {
  const response = await fetch(baseUrl + path);
  return { status: response.status, body: await response.json() };
}

let counter = 0;
const next = () => (counter += 1);

async function makeSeller({ status = "approved", userStatus = "active" } = {}) {
  const n = next();
  const { rows: users } = await db.query(
    `INSERT INTO users (name, email, role, status, email_verified_at, terms_accepted_at, terms_version)
     VALUES ('Test', $1, 'seller', $2, NOW(), NOW(), 'v1') RETURNING id`,
    [`browse${n}@example.com`, userStatus]
  );
  const { rows } = await db.query(
    `INSERT INTO seller_profiles (user_id, store_name, store_slug, legal_business_name, verification_status, tax_id,
                                  support_email, payout_account_id, rejection_reason)
     VALUES ($1, 'Mug House', $2, 'Mug House Pvt Ltd', $3, '22AAAAA0000A1Z5', 'help@mughouse.test', 'acct_secret', $4)
     RETURNING id, user_id`,
    [users[0].id, `store-${n}`, status, status === "rejected" ? "Reason" : null]
  );
  return rows[0];
}

async function makeCategory(name, { parentId = null, isActive = true } = {}) {
  const { rows } = await db.query(
    "INSERT INTO categories (name, slug, parent_id, is_active) VALUES ($1, $2, $3, $4) RETURNING id",
    [name, `cat-${next()}`, parentId, isActive]
  );
  return rows[0].id;
}

async function makeBrand(name) {
  const { rows } = await db.query("INSERT INTO brands (name, slug) VALUES ($1, $2) RETURNING id", [name, `brand-${next()}`]);
  return rows[0].id;
}

// A complete, published product. `variants` are { price, mrp, stock, options, labels, isActive }.
async function makeProduct({
  seller,
  categoryId,
  brandId = null,
  title = "Ceramic Mug",
  genericName = "Mug",
  status = "active",
  variants = [{}],
  image = true,
  createdAt = null,
}) {
  const n = next();
  const { rows } = await db.query(
    `INSERT INTO products (seller_id, category_id, brand_id, title, slug, generic_name, country_of_origin, manufacturer_name,
                           manufacturer_address, hsn_code, status, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'IN', 'Maker Ltd', '1 Road, Pune', '6912', $7, COALESCE($8, NOW())) RETURNING id, slug`,
    [seller.id, categoryId, brandId, title, `product-${n}`, genericName, status, createdAt]
  );
  const product = rows[0];
  for (const variant of variants) {
    await db.query(
      `INSERT INTO product_variants (product_id, seller_id, sku, options, option_labels, mrp, selling_price, net_quantity,
                                     stock_quantity, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, '1 N', $8, $9)`,
      [
        product.id,
        seller.id,
        `SKU-${next()}`,
        JSON.stringify(variant.options ?? {}),
        JSON.stringify(variant.labels ?? {}),
        variant.mrp ?? variant.price ?? "500.00",
        variant.price ?? "500.00",
        variant.stock ?? 10,
        variant.isActive ?? true,
      ]
    );
  }
  await db.query(
    `UPDATE products SET min_price =
       (SELECT MIN(selling_price) FROM product_variants WHERE product_id = $1 AND is_active AND deleted_at IS NULL)
     WHERE id = $1`,
    [product.id]
  );
  if (image) {
    await db.query(
      `INSERT INTO product_images (product_id, storage_provider, storage_key, url, alt_text, is_primary)
       VALUES ($1, 'r2', $2, 'https://cdn.test/main.png', 'Front', TRUE)`,
      [product.id, `key-${next()}`]
    );
  }
  return product;
}

const titles = (res) => res.body.products.map((product) => product.title);
const isVisible = async (product) => {
  const [listed, detail] = await Promise.all([get("/products?limit=50"), get(`/products/${product.slug}`)]);
  const inList = listed.body.products.some((row) => row.id === product.id);
  assert.equal(inList, detail.status === 200, "the list and the product page must agree");
  return inList;
};

let seller;
let categoryId;

beforeEach(async () => {
  limiters.publicRead.resetKey("::ffff:127.0.0.1");
  limiters.publicRead.resetKey("127.0.0.1");
  await db.query("TRUNCATE users, categories, brands, variant_options CASCADE");
  seller = await makeSeller();
  categoryId = await makeCategory("Mugs");
});

// ---------- What customers can see ----------

test("a complete, published product is visible with no login", async () => {
  const product = await makeProduct({ seller, categoryId });
  assert.equal(await isVisible(product), true);
});

const hiddenCases = [
  ["a draft", { status: "draft" }],
  ["a paused product", { status: "paused" }],
  ["a product with no image", { image: false }],
  ["a product with no variants", { variants: [] }],
  ["a product whose variants are all inactive", { variants: [{ isActive: false }] }],
];
for (const [name, fields] of hiddenCases) {
  test(`${name} is hidden`, async () => {
    const product = await makeProduct({ seller, categoryId, ...fields });
    assert.equal(await isVisible(product), false);
  });
}

for (const status of ["pending", "rejected", "suspended"]) {
  test(`products of a ${status} seller are hidden`, async () => {
    const product = await makeProduct({ seller: await makeSeller({ status }), categoryId });
    assert.equal(await isVisible(product), false);
  });
}

for (const userStatus of ["inactive", "suspended"]) {
  test(`products of an approved seller whose account is ${userStatus} are hidden`, async () => {
    const product = await makeProduct({ seller: await makeSeller({ userStatus }), categoryId });
    assert.equal(await isVisible(product), false);
  });
}

test("hiding takes effect at once and undoing it brings the product back", async () => {
  const product = await makeProduct({ seller, categoryId });
  const changes = [
    ["UPDATE products SET blocked_at = NOW(), blocked_reason = 'x' WHERE id = $1", "UPDATE products SET blocked_at = NULL, blocked_reason = NULL WHERE id = $1", product.id],
    ["UPDATE products SET deleted_at = NOW() WHERE id = $1", "UPDATE products SET deleted_at = NULL WHERE id = $1", product.id],
    ["UPDATE seller_profiles SET verification_status = 'suspended' WHERE id = $1", "UPDATE seller_profiles SET verification_status = 'approved' WHERE id = $1", seller.id],
    ["UPDATE users SET deleted_at = NOW() WHERE id = $1", "UPDATE users SET deleted_at = NULL WHERE id = $1", seller.user_id],
    ["UPDATE categories SET is_active = FALSE WHERE id = $1", "UPDATE categories SET is_active = TRUE WHERE id = $1", categoryId],
  ];
  for (const [hide, undo, id] of changes) {
    await db.query(hide, [id]);
    assert.equal(await isVisible(product), false, hide);
    await db.query(undo, [id]);
    assert.equal(await isVisible(product), true, undo);
  }
});

test("an inactive category hides products in every category below it", async () => {
  const top = await makeCategory("Home");
  const middle = await makeCategory("Kitchen", { parentId: top });
  const lowest = await makeCategory("Cups", { parentId: middle });
  const product = await makeProduct({ seller, categoryId: lowest });
  assert.equal(await isVisible(product), true);

  for (const id of [top, middle]) {
    await db.query("UPDATE categories SET is_active = FALSE WHERE id = $1", [id]);
    assert.equal(await isVisible(product), false);
    await db.query("UPDATE categories SET is_active = TRUE WHERE id = $1", [id]);
  }
  await db.query("UPDATE categories SET is_active = FALSE WHERE id = $1", [middle]);
  const filtered = await get(`/products?categoryId=${top}`);
  assert.equal(filtered.body.pagination.total, 0);
});

test("an out-of-stock product stays visible, marked out of stock", async () => {
  const product = await makeProduct({ seller, categoryId, variants: [{ stock: 0 }] });
  const { body } = await get("/products");
  assert.equal(body.products[0].inStock, false);
  const detail = await get(`/products/${product.slug}`);
  assert.equal(detail.body.product.inStock, false);
  assert.equal(detail.body.product.variants[0].inStock, false);
});

test("a product stays visible when its brand is deactivated", async () => {
  const brandId = await makeBrand("Acme");
  const product = await makeProduct({ seller, categoryId, brandId });
  await db.query("UPDATE brands SET is_active = FALSE WHERE id = $1", [brandId]);
  assert.equal(await isVisible(product), true);
});

// ---------- What the responses contain ----------

test("seller-only data never reaches customers", async () => {
  const product = await makeProduct({ seller, categoryId, variants: [{ stock: 37 }] });
  const responses = [await get("/products"), await get(`/products/${product.slug}`)];
  for (const { status, body } of responses) {
    assert.equal(status, 200);
    const json = JSON.stringify(body);
    for (const secret of ["22AAAAA0000A1Z5", "acct_secret", "SKU-", '"6912"', "storage", "commission", "stockQuantity", "sellerId", "blocked", "status"]) {
      assert.equal(json.includes(secret), false, `response contains ${secret}`);
    }
    assert.equal(json.includes(":37"), false, "response contains the exact stock");
  }
});

test("the product page has the legal details, seller contact, images and prices", async () => {
  const brandId = await makeBrand("Acme");
  const product = await makeProduct({ seller, categoryId, brandId, variants: [{ price: "749.50", mrp: "999.00" }] });
  const { status, body } = await get(`/products/${product.slug}`);
  assert.equal(status, 200);
  const page = body.product;
  assert.deepEqual(page.legal, {
    genericName: "Mug",
    countryOfOrigin: "IN",
    manufacturerName: "Maker Ltd",
    manufacturerAddress: "1 Road, Pune",
    packerDetails: null,
    importerDetails: null,
  });
  assert.equal(page.seller.legalBusinessName, "Mug House Pvt Ltd");
  assert.equal(page.seller.supportEmail, "help@mughouse.test");
  assert.equal(page.brand.name, "Acme");
  assert.deepEqual(page.returns, { isReturnable: true, windowDays: 7 });
  assert.equal(page.images[0].url, "https://cdn.test/main.png");
  assert.equal(page.images[0].isPrimary, true);
  assert.equal(page.variants[0].price, "749.50");
  assert.equal(page.variants[0].mrp, "999.00");
  assert.equal(page.variants[0].discountPercent, 24); // 24.97% is shown as 24, never rounded up
});

test("the list shows the cheapest variant's price, MRP and discount, and ignores inactive variants", async () => {
  await makeProduct({
    seller,
    categoryId,
    variants: [
      { price: "100.00", mrp: "900.00", isActive: false, options: { a: "1" } },
      { price: "300.00", mrp: "600.00", options: { a: "2" } },
      { price: "400.00", mrp: "400.00", options: { a: "3" } },
    ],
  });
  const { body } = await get("/products");
  assert.equal(body.products[0].price, "300.00");
  assert.equal(body.products[0].mrp, "600.00");
  assert.equal(body.products[0].discountPercent, 50);
  assert.equal(body.products[0].image.url, "https://cdn.test/main.png");
});

test("only variants on sale are returned on the product page", async () => {
  const product = await makeProduct({
    seller,
    categoryId,
    variants: [
      { price: "300.00", options: { a: "1" } },
      { price: "100.00", options: { a: "2" }, isActive: false },
    ],
  });
  const { body } = await get(`/products/${product.slug}`);
  assert.equal(body.product.variants.length, 1);
  assert.equal(body.product.variants[0].price, "300.00");
});

test("option choices have readable labels, including custom and deleted values, in the admin's order", async () => {
  const { rows: options } = await db.query(
    `INSERT INTO variant_options (name, code, allow_custom_values)
     VALUES ('Size', 'size', FALSE), ('Colour', 'colour', TRUE) RETURNING id, code`
  );
  const size = options.find((option) => option.code === "size").id;
  const colour = options.find((option) => option.code === "colour").id;
  await db.query(
    `INSERT INTO variant_option_values (option_id, label, code, sort_order, color_hex) VALUES
     ($1, 'Large', 'l', 2, NULL), ($1, 'Medium', 'm', 1, NULL), ($2, 'Red', 'red', 0, '#FF0000')`,
    [size, colour]
  );
  await db.query(
    "INSERT INTO category_variant_options (category_id, option_id, sort_order) VALUES ($1, $2, 1), ($1, $3, 2)",
    [categoryId, colour, size]
  );
  // Large is deleted after a variant used it: the variant keeps its code, and the label still shows.
  await db.query("UPDATE variant_option_values SET deleted_at = NOW() WHERE code = 'l'");

  const product = await makeProduct({
    seller,
    categoryId,
    variants: [
      { options: { size: "l", colour: "red" } },
      { options: { size: "m", colour: "midnight-blue" }, labels: { colour: "Midnight Blue" } },
      { options: { size: "s", colour: "red" }, isActive: false },
    ],
  });
  const { body } = await get(`/products/${product.slug}`);
  assert.deepEqual(body.product.options, [
    {
      code: "colour",
      name: "Colour",
      values: [
        { code: "red", label: "Red", colorHex: "#FF0000" },
        { code: "midnight-blue", label: "Midnight Blue", colorHex: null },
      ],
    },
    {
      code: "size",
      name: "Size",
      values: [
        { code: "m", label: "Medium", colorHex: null },
        { code: "l", label: "Large", colorHex: null },
      ],
    },
  ]);
  assert.deepEqual(body.product.variants[0].options, { size: "l", colour: "red" });
});

test("a product with no options has an empty choice list", async () => {
  const product = await makeProduct({ seller, categoryId });
  const { body } = await get(`/products/${product.slug}`);
  assert.deepEqual(body.product.options, []);
});

test("an unknown product is 404, and a badly formed slug is 400", async () => {
  assert.equal((await get("/products/no-such-product")).body.code, "NOT_FOUND");
  assert.equal((await get("/products/no-such-product")).status, 404);
  assert.equal((await get("/products/BAD%00SLUG")).status, 400);
});

// ---------- Search ----------

test("search finds whole words, other forms of a word, and the generic name", async () => {
  await makeProduct({ seller, categoryId, title: "Ceramic Coffee Mug", genericName: "Drinkware" });
  await makeProduct({ seller, categoryId, title: "Steel Bottle", genericName: "Flask" });
  assert.deepEqual(titles(await get("/products?q=ceramic")), ["Ceramic Coffee Mug"]);
  assert.deepEqual(titles(await get("/products?q=mugs")), ["Ceramic Coffee Mug"]);
  assert.deepEqual(titles(await get("/products?q=COFFEE%20mug")), ["Ceramic Coffee Mug"]);
  assert.deepEqual(titles(await get("/products?q=flask")), ["Steel Bottle"]);
  assert.deepEqual(titles(await get("/products?q=television")), []);
});

test("search tolerates typos", async () => {
  await makeProduct({ seller, categoryId, title: "Samsung Galaxy Phone" });
  await makeProduct({ seller, categoryId, title: "Steel Bottle" });
  assert.deepEqual(titles(await get("/products?q=samsng")), ["Samsung Galaxy Phone"]);
  assert.deepEqual(titles(await get("/products?q=galaxi")), ["Samsung Galaxy Phone"]);
});

test("search ranks the best match first, unless another sort is chosen", async () => {
  await makeProduct({ seller, categoryId, title: "Steel Bottle Holder", genericName: "Mug", variants: [{ price: "100.00" }] });
  await makeProduct({ seller, categoryId, title: "Big Mug", genericName: "Drinkware", variants: [{ price: "900.00" }] });
  assert.deepEqual(titles(await get("/products?q=mug")), ["Big Mug", "Steel Bottle Holder"]);
  assert.deepEqual(titles(await get("/products?q=mug&sort=price_asc")), ["Steel Bottle Holder", "Big Mug"]);
});

test("search text is treated as text, and an empty search means no search", async () => {
  await makeProduct({ seller, categoryId, title: "Ceramic Mug" });
  for (const q of ["'; DROP TABLE products; --", "%", "_", '"', "a:b & !c", "(", "\\"]) {
    const res = await get(`/products?q=${encodeURIComponent(q)}`);
    assert.equal(res.status, 200, q);
    assert.equal(res.body.pagination.total, 0, q);
  }
  assert.equal((await get("/products?q=")).body.pagination.total, 1);
  assert.equal((await get("/products?q=%20%20")).body.pagination.total, 1);
});

test("search doesn't find hidden products", async () => {
  await makeProduct({ seller, categoryId, title: "Secret Mug", status: "draft" });
  assert.deepEqual(titles(await get("/products?q=secret")), []);
});

// ---------- Filters ----------

test("a category filter includes everything below it", async () => {
  const top = await makeCategory("Home");
  const middle = await makeCategory("Kitchen", { parentId: top });
  const lowest = await makeCategory("Cups", { parentId: middle });
  await makeProduct({ seller, categoryId: lowest, title: "Cup" });
  await makeProduct({ seller, categoryId, title: "Other" });
  for (const id of [top, middle, lowest]) assert.deepEqual(titles(await get(`/products?categoryId=${id}`)), ["Cup"]);
  assert.deepEqual(titles(await get("/products?categoryId=00000000-0000-7000-8000-000000000000")), []);
});

test("brand filter takes one or several brands, either way of writing them", async () => {
  const a = await makeBrand("A");
  const b = await makeBrand("B");
  const c = await makeBrand("C");
  await makeProduct({ seller, categoryId, brandId: a, title: "A1" });
  await makeProduct({ seller, categoryId, brandId: b, title: "B1" });
  await makeProduct({ seller, categoryId, brandId: c, title: "C1" });
  await makeProduct({ seller, categoryId, title: "None" });
  assert.deepEqual(titles(await get(`/products?brandId=${a}`)), ["A1"]);
  assert.deepEqual(new Set(titles(await get(`/products?brandId=${a},${b}`))), new Set(["A1", "B1"]));
  assert.deepEqual(new Set(titles(await get(`/products?brandId=${a}&brandId=${c}`))), new Set(["A1", "C1"]));
});

test("price filters use the price shown, including the limits themselves", async () => {
  await makeProduct({ seller, categoryId, title: "Cheap", variants: [{ price: "100.00" }] });
  await makeProduct({ seller, categoryId, title: "Mid", variants: [{ price: "500.00", options: { a: "1" } }, { price: "2000.00", options: { a: "2" } }] });
  await makeProduct({ seller, categoryId, title: "Dear", variants: [{ price: "999.50" }] });
  assert.deepEqual(new Set(titles(await get("/products?minPrice=500"))), new Set(["Mid", "Dear"]));
  assert.deepEqual(new Set(titles(await get("/products?maxPrice=500.00"))), new Set(["Cheap", "Mid"]));
  assert.deepEqual(titles(await get("/products?minPrice=999.50&maxPrice=999.50")), ["Dear"]);
  assert.deepEqual(titles(await get("/products?minPrice=1000")), []); // Mid's shown price is 500
  assert.equal((await get("/products?minPrice=0")).body.pagination.total, 3);
});

test("in-stock filter counts only active variants", async () => {
  await makeProduct({ seller, categoryId, title: "Has", variants: [{ stock: 0, options: { a: "1" } }, { stock: 2, options: { a: "2" } }] });
  await makeProduct({ seller, categoryId, title: "None", variants: [{ stock: 0 }] });
  await makeProduct({ seller, categoryId, title: "Inactive", variants: [{ stock: 0, options: { a: "1" } }, { stock: 5, isActive: false, options: { a: "2" } }] });
  assert.deepEqual(titles(await get("/products?inStock=true")), ["Has"]);
  assert.equal((await get("/products?inStock=false")).body.pagination.total, 3);
  assert.equal((await get("/products")).body.pagination.total, 3);
});

test("option filters: alternatives within an option, all options on one variant", async () => {
  const redM = { options: { size: "m", colour: "red" } };
  const blueL = { options: { size: "l", colour: "blue" } };
  await makeProduct({ seller, categoryId, title: "RedM", variants: [redM] });
  await makeProduct({ seller, categoryId, title: "BlueL", variants: [blueL] });
  await makeProduct({ seller, categoryId, title: "RedL-BlueM", variants: [{ options: { size: "l", colour: "red" } }, { options: { size: "m", colour: "blue" } }] });
  await makeProduct({ seller, categoryId, title: "SoldOutM", variants: [{ options: { size: "m", colour: "red" }, stock: 0 }, { options: { size: "l", colour: "red" }, stock: 5 }] });
  await makeProduct({ seller, categoryId, title: "InactiveM", variants: [{ options: { size: "m", colour: "green" }, isActive: false }, { options: { size: "l", colour: "green" } }] });

  // Red and M exist on RedL-BlueM, but not on the same variant.
  assert.deepEqual(new Set(titles(await get("/products?option=size:m&option=colour:red"))), new Set(["RedM", "SoldOutM"]));
  // Alternatives, in both ways of writing them.
  assert.deepEqual(
    new Set(titles(await get("/products?option=colour:red,colour:green&option=size:m"))),
    new Set(["RedM", "SoldOutM"])
  );
  assert.equal((await get("/products?option=size:m&option=size:l")).body.pagination.total, 5);
  // M must be the variant in stock.
  assert.deepEqual(new Set(titles(await get("/products?option=size:m&inStock=true"))), new Set(["RedM", "RedL-BlueM"]));
  // An inactive variant doesn't count.
  assert.deepEqual(titles(await get("/products?option=colour:green&option=size:m")), []);
  assert.deepEqual(titles(await get("/products?option=size:xxl")), []);
});

test("filters combine", async () => {
  const brandId = await makeBrand("Acme");
  await makeProduct({ seller, categoryId, brandId, title: "Ceramic Mug", variants: [{ price: "300.00" }] });
  await makeProduct({ seller, categoryId, brandId, title: "Ceramic Plate", variants: [{ price: "900.00" }] });
  await makeProduct({ seller, categoryId, title: "Ceramic Bowl", variants: [{ price: "300.00" }] });
  const res = await get(`/products?q=ceramic&brandId=${brandId}&categoryId=${categoryId}&maxPrice=500&inStock=true&sort=price_desc`);
  assert.deepEqual(titles(res), ["Ceramic Mug"]);
  assert.equal(res.body.pagination.total, 1);
});

// ---------- Sorting and pages ----------

test("sorting by newest (the default) and by price", async () => {
  const day = (n) => `2026-10-0${n}T00:00:00Z`;
  await makeProduct({ seller, categoryId, title: "Old", createdAt: day(1), variants: [{ price: "200.00" }] });
  await makeProduct({ seller, categoryId, title: "New", createdAt: day(3), variants: [{ price: "300.00" }] });
  await makeProduct({ seller, categoryId, title: "Mid", createdAt: day(2), variants: [{ price: "100.00" }] });
  assert.deepEqual(titles(await get("/products")), ["New", "Mid", "Old"]);
  assert.deepEqual(titles(await get("/products?sort=newest")), ["New", "Mid", "Old"]);
  assert.deepEqual(titles(await get("/products?sort=relevance")), ["New", "Mid", "Old"]); // nothing to rank without a search
  assert.deepEqual(titles(await get("/products?sort=price_asc")), ["Mid", "Old", "New"]);
  assert.deepEqual(titles(await get("/products?sort=price_desc")), ["New", "Old", "Mid"]);
});

test("pages have no repeats or gaps when products have equal prices", async () => {
  for (let i = 0; i < 7; i += 1) await makeProduct({ seller, categoryId, title: `P${i}`, variants: [{ price: "100.00" }] });
  const seen = [];
  for (const page of [1, 2, 3]) {
    const res = await get(`/products?sort=price_asc&limit=3&page=${page}`);
    assert.deepEqual(res.body.pagination, { page, limit: 3, total: 7 });
    seen.push(...titles(res));
  }
  assert.equal(seen.length, 7);
  assert.equal(new Set(seen).size, 7);
  assert.deepEqual(titles(await get("/products?limit=3&page=4")), []);
});

test("the default page size is 24", async () => {
  const { body } = await get("/products");
  assert.deepEqual(body.pagination, { page: 1, limit: 24, total: 0 });
});

// ---------- Bad input ----------

test("bad input gets a 400, never a 500", async () => {
  const uuid = "00000000-0000-7000-8000-000000000000";
  const bad = [
    "limit=51",
    "limit=0",
    "page=0",
    "page=1001",
    "page=99999999999999999999",
    "page=abc",
    "sort=random",
    "minPrice=-1",
    "minPrice=abc",
    "maxPrice=1.234",
    "minPrice=99999999999",
    "minPrice=500&maxPrice=100",
    "inStock=maybe",
    "categoryId=abc",
    `categoryId=${uuid}&categoryId=${uuid}`,
    "brandId=abc",
    `brandId=${Array(21).fill(uuid).join(",")}`,
    "option=size",
    "option=SIZE:M",
    "option=size:m:l",
    `option=${Array(21).fill("size:m").join(",")}`,
    "q=a%00b",
    "q=a&q=b",
    `q=${"x".repeat(101)}`,
  ];
  for (const query of bad) {
    const res = await get(`/products?${query}`);
    assert.equal(res.status, 400, query);
    assert.equal(res.body.code, "VALIDATION_ERROR", query);
  }
  assert.equal((await get("/brands?q=a%00b")).status, 400);
});

test("unknown query parameters, such as tracking tags, are ignored", async () => {
  assert.equal((await get("/products?utm_source=mail&foo=bar")).status, 200);
});
