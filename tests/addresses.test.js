// Tests of the address book, the addresses table and the state list against a real Postgres.
// TEST_DATABASE_URL must point at a migrated, disposable database: its data is deleted.

const { after, before, beforeEach, test } = require("node:test");
const assert = require("node:assert/strict");

require("./testEnv");

const app = require("../src/app");
const db = require("../src/config/db");
const UserModel = require("../src/models/user.model");
const { INDIAN_STATES } = require("../src/utils/indianStates");
const { signAccessToken } = require("../src/utils/token");

let server;
let baseUrl;
const logged = console.log;
const MISSING_ID = "00000000-0000-7000-8000-000000000000";

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

let userId;
let token;

beforeEach(async () => {
  await db.query("TRUNCATE users, categories CASCADE");
  const { rows } = await db.query(
    `INSERT INTO users (name, email, role, email_verified_at, terms_accepted_at, terms_version)
     VALUES ('Test', 'address@example.com', 'seller', NOW(), NOW(), 'v1') RETURNING id, role`
  );
  userId = rows[0].id;
  token = signAccessToken(rows[0]);
});

// Inserts an address, with any column overridden. A column set to undefined is left out.
async function insert(overrides = {}) {
  const row = {
    user_id: userId,
    full_name: "Asha Rao",
    phone: "+919876543210",
    address_line1: "12 MG Road",
    city: "Pune",
    state: "Maharashtra",
    state_code: "27",
    postal_code: "411001",
    ...overrides,
  };
  const columns = Object.keys(row).filter((column) => row[column] !== undefined);
  const placeholders = columns.map((_, index) => `$${index + 1}`);
  const { rows } = await db.query(
    `INSERT INTO addresses (${columns.join(", ")}) VALUES (${placeholders.join(", ")}) RETURNING *`,
    columns.map((column) => row[column])
  );
  return rows[0];
}

const fails = (promise, code) => assert.rejects(promise, (err) => err.code === code);

test("the state list has all 36 states and union territories, once each", () => {
  assert.equal(INDIAN_STATES.length, 36);
  assert.equal(new Set(INDIAN_STATES.map((state) => state.code)).size, 36);
  assert.equal(new Set(INDIAN_STATES.map((state) => state.name)).size, 36);
  for (const { code, name } of INDIAN_STATES) {
    assert.match(code, /^[0-9]{2}$/);
    assert.ok(name.length <= 100, name);
  }
  const named = (code) => INDIAN_STATES.find((state) => state.code === code)?.name;
  assert.equal(named("27"), "Maharashtra");
  assert.equal(named("37"), "Andhra Pradesh");
  assert.equal(named("36"), "Telangana");
  assert.equal(named("38"), "Ladakh");
  for (const retired of ["25", "28", "97", "99"]) assert.equal(named(retired), undefined, retired);
});

test("a valid address saves, with India as the default country", async () => {
  const address = await insert();
  assert.equal(address.state_code, "27");
  assert.equal(address.country_code, "IN");
  assert.equal("deleted_at" in address, false);
});

test("a state code is required and must be 2 digits", async () => {
  await fails(insert({ state_code: undefined }), "23502");
  for (const state_code of ["MH", "2", "2A"]) await fails(insert({ state_code }), "23514");
});

test("an Indian PIN code must be 6 digits, not starting with 0", async () => {
  for (const postal_code of ["1", "12345", "1234567", "011001", "41100A", "411 001"]) {
    await fails(insert({ postal_code }), "23514");
  }
  assert.equal((await insert({ postal_code: "110001" })).postal_code, "110001");
});

test("each user has at most one default shipping and one default billing address", async () => {
  await insert({ is_default_shipping: true, is_default_billing: true });
  await fails(insert({ is_default_shipping: true }), "23505");
  await fails(insert({ is_default_billing: true }), "23505");
  await insert(); // not a default, so it's fine

  const { rows } = await db.query(
    `INSERT INTO users (name, email, role, email_verified_at, terms_accepted_at, terms_version)
     VALUES ('Other', 'other@example.com', 'customer', NOW(), NOW(), 'v1') RETURNING id`
  );
  await insert({ user_id: rows[0].id, is_default_shipping: true, is_default_billing: true });
});

test("deleting an address really removes it, and frees its default", async () => {
  const address = await insert({ is_default_shipping: true });
  await db.query("DELETE FROM addresses WHERE id = $1", [address.id]);
  const { rowCount } = await db.query("SELECT 1 FROM addresses WHERE id = $1", [address.id]);
  assert.equal(rowCount, 0);
  await insert({ is_default_shipping: true });
});

test("a store's pickup address can't point at a removed address", async () => {
  const address = await insert();
  const { rows } = await db.query(
    `INSERT INTO seller_profiles (user_id, store_name, store_slug, legal_business_name, pickup_address_id)
     VALUES ($1, 'Store', 'store', 'Legal', $2) RETURNING id`,
    [userId, address.id]
  );
  await db.query("DELETE FROM addresses WHERE id = $1", [address.id]);
  const after = await db.query("SELECT pickup_address_id FROM seller_profiles WHERE id = $1", [rows[0].id]);
  assert.equal(after.rows[0].pickup_address_id, null);
});

test("deleting a user removes their addresses", async () => {
  const address = await insert();
  await db.query("DELETE FROM users WHERE id = $1", [userId]);
  const { rowCount } = await db.query("SELECT 1 FROM addresses WHERE id = $1", [address.id]);
  assert.equal(rowCount, 0);
});

// ---------- The API ----------

async function api(method, path, { body, as = token } = {}) {
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

const VALID = {
  fullName: "Asha Rao",
  phone: "+919876543210",
  addressLine1: "12 MG Road",
  city: "Pune",
  stateCode: "27",
  postalCode: "411001",
};

async function add(fields = {}, as = token) {
  const res = await api("POST", "/addresses", { body: { ...VALID, ...fields }, as });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.address;
}

const list = async (as = token) => (await api("GET", "/addresses", { as })).body.addresses;
const defaults = async (as = token) => {
  const addresses = await list(as);
  return {
    shipping: addresses.filter((address) => address.isDefaultShipping).map((address) => address.id),
    billing: addresses.filter((address) => address.isDefaultBilling).map((address) => address.id),
  };
};

async function makeUser(role, email) {
  const { rows } = await db.query(
    `INSERT INTO users (name, email, role, email_verified_at, terms_accepted_at, terms_version)
     VALUES ('Other', $1, $2, NOW(), NOW(), 'v1') RETURNING id, role`,
    [email, role]
  );
  return signAccessToken(rows[0]);
}

test("the state list is public", async () => {
  const res = await api("GET", "/states", { as: null });
  assert.equal(res.status, 200);
  assert.equal(res.body.states.length, 36);
  assert.deepEqual(res.body.states.find((state) => state.code === "27"), { code: "27", name: "Maharashtra" });
});

test("customers and sellers have address books; admins and visitors don't", async () => {
  const customer = await makeUser("customer", "customer@example.com");
  assert.equal((await add({}, customer)).city, "Pune");
  assert.equal((await add({}, token)).city, "Pune");

  const admin = await makeUser("admin", "admin@example.com");
  for (const [as, status] of [[admin, 403], [null, 401]]) {
    assert.equal((await api("GET", "/addresses", { as })).status, status);
    assert.equal((await api("POST", "/addresses", { as, body: VALID })).status, status);
    assert.equal((await api("GET", `/addresses/${MISSING_ID}`, { as })).status, status);
    assert.equal((await api("PATCH", `/addresses/${MISSING_ID}`, { as, body: { city: "X" } })).status, status);
    assert.equal((await api("DELETE", `/addresses/${MISSING_ID}`, { as })).status, status);
  }
});

test("creating saves every field, with the state name filled in by the server", async () => {
  const address = await add({ label: "Home", addressLine2: "Camp", landmark: "Near the bank", stateCode: "29" });
  assert.equal(address.label, "Home");
  assert.equal(address.fullName, "Asha Rao");
  assert.equal(address.phone, "+919876543210");
  assert.equal(address.addressLine1, "12 MG Road");
  assert.equal(address.addressLine2, "Camp");
  assert.equal(address.landmark, "Near the bank");
  assert.equal(address.state, "Karnataka");
  assert.equal(address.stateCode, "29");
  assert.equal(address.postalCode, "411001");
  assert.equal(address.countryCode, "IN");
  assert.equal((await api("GET", `/addresses/${address.id}`)).body.address.state, "Karnataka");
});

test("bad input gets a 400 naming the field, and saves nothing", async () => {
  const cases = [
    ["fullName", undefined],
    ["fullName", "   "],
    ["fullName", "x".repeat(101)],
    ["phone", undefined],
    ["phone", "9876543210"],
    ["phone", "+915876543210"],
    ["phone", "+14155550100"],
    ["addressLine1", undefined],
    ["addressLine1", ""],
    ["city", undefined],
    ["stateCode", undefined],
    ["stateCode", "MH"],
    ["stateCode", "25"],
    ["stateCode", "97"],
    ["postalCode", undefined],
    ["postalCode", "011001"],
    ["postalCode", "41100"],
    ["label", "x".repeat(51)],
    ["isDefaultShipping", false],
    ["isDefaultBilling", "yes"],
    ["state", "Maharashtra"],
    ["countryCode", "US"],
    ["userId", MISSING_ID],
  ];
  for (const [field, value] of cases) {
    const res = await api("POST", "/addresses", { body: { ...VALID, [field]: value } });
    assert.equal(res.status, 400, `${field}=${value}`);
    assert.equal(res.body.code, "VALIDATION_ERROR");
    const named = res.body.details.some((detail) => detail.field === field || detail.message.includes(field));
    assert.ok(named, `${field}: ${JSON.stringify(res.body.details)}`);
  }
  assert.deepEqual(await list(), []);
});

test("someone else's address is a 404, and is left alone", async () => {
  const mine = await add();
  const other = await makeUser("customer", "other@example.com");
  assert.equal((await api("GET", `/addresses/${mine.id}`, { as: other })).status, 404);
  assert.equal((await api("PATCH", `/addresses/${mine.id}`, { as: other, body: { city: "X", isDefaultShipping: true } })).status, 404);
  assert.equal((await api("DELETE", `/addresses/${mine.id}`, { as: other })).status, 404);
  assert.deepEqual(await list(other), []);
  assert.equal((await api("GET", `/addresses/${mine.id}`)).body.address.city, "Pune");
  assert.equal((await defaults()).shipping[0], mine.id);
});

test("an unknown id is 404, and a bad id is 400", async () => {
  assert.equal((await api("GET", `/addresses/${MISSING_ID}`)).status, 404);
  assert.equal((await api("PATCH", `/addresses/${MISSING_ID}`, { body: { city: "X" } })).status, 404);
  assert.equal((await api("DELETE", `/addresses/${MISSING_ID}`)).status, 404);
  assert.equal((await api("GET", "/addresses/abc")).status, 400);
  assert.equal((await api("DELETE", "/addresses/abc")).status, 400);
});

test("the first address becomes both defaults, and later ones don't", async () => {
  const first = await add();
  assert.equal(first.isDefaultShipping, true);
  assert.equal(first.isDefaultBilling, true);
  const second = await add();
  assert.equal(second.isDefaultShipping, false);
  assert.equal(second.isDefaultBilling, false);
});

test("a new address can take over a default, and each default moves separately", async () => {
  const first = await add();
  const shipping = await add({ isDefaultShipping: true });
  assert.deepEqual(await defaults(), { shipping: [shipping.id], billing: [first.id] });
  const billing = await add({ isDefaultBilling: true });
  assert.deepEqual(await defaults(), { shipping: [shipping.id], billing: [billing.id] });
});

test("changing or deleting my default doesn't touch another user's defaults", async () => {
  const other = await makeUser("customer", "neighbour@example.com");
  const theirs = await add({}, other);
  const first = await add();
  await add({ isDefaultShipping: true, isDefaultBilling: true });
  await api("PATCH", `/addresses/${first.id}`, { body: { isDefaultShipping: true, isDefaultBilling: true } });
  await api("DELETE", `/addresses/${first.id}`);
  assert.deepEqual(await defaults(other), { shipping: [theirs.id], billing: [theirs.id] });
});

test("the list has defaults first, then newest", async () => {
  const first = await add();
  const second = await add();
  const third = await add();
  assert.deepEqual((await list()).map((address) => address.id), [first.id, third.id, second.id]);
  await api("PATCH", `/addresses/${second.id}`, { body: { isDefaultShipping: true, isDefaultBilling: true } });
  assert.deepEqual((await list()).map((address) => address.id), [second.id, third.id, first.id]);
});

test("editing changes only what was sent, and null clears an optional field", async () => {
  const address = await add({ label: "Home", landmark: "Near the bank" });
  const res = await api("PATCH", `/addresses/${address.id}`, { body: { city: "Mumbai", label: null } });
  assert.equal(res.status, 200);
  assert.equal(res.body.address.city, "Mumbai");
  assert.equal(res.body.address.label, null);
  assert.equal(res.body.address.landmark, "Near the bank");
  assert.equal(res.body.address.fullName, "Asha Rao");
  assert.equal(res.body.address.state, "Maharashtra");
});

test("changing the state code changes the state name with it", async () => {
  const address = await add();
  const res = await api("PATCH", `/addresses/${address.id}`, { body: { stateCode: "07" } });
  assert.equal(res.body.address.stateCode, "07");
  assert.equal(res.body.address.state, "Delhi");
});

test("bad edits get a 400", async () => {
  const address = await add();
  const bad = [
    {},
    { fullName: null },
    { phone: null },
    { addressLine1: null },
    { city: null },
    { stateCode: null },
    { postalCode: null },
    { postalCode: "1" },
    { stateCode: "MH" },
    { state: "Delhi" },
    { countryCode: "US" },
    { isDefaultShipping: false },
    { isDefaultBilling: null },
  ];
  for (const body of bad) {
    assert.equal((await api("PATCH", `/addresses/${address.id}`, { body })).status, 400, JSON.stringify(body));
  }
});

test("an edit can make an address the default, including one already the default", async () => {
  const first = await add();
  const second = await add();
  const res = await api("PATCH", `/addresses/${second.id}`, { body: { isDefaultShipping: true } });
  assert.equal(res.body.address.isDefaultShipping, true);
  assert.deepEqual(await defaults(), { shipping: [second.id], billing: [first.id] });

  const again = await api("PATCH", `/addresses/${second.id}`, { body: { isDefaultShipping: true } });
  assert.equal(again.status, 200);
  assert.deepEqual(await defaults(), { shipping: [second.id], billing: [first.id] });
});

test("deleting really removes an address", async () => {
  const address = await add();
  assert.equal((await api("DELETE", `/addresses/${address.id}`)).status, 204);
  assert.equal((await api("GET", `/addresses/${address.id}`)).status, 404);
  assert.equal((await db.query("SELECT 1 FROM addresses WHERE id = $1", [address.id])).rowCount, 0);
  assert.equal((await api("DELETE", `/addresses/${address.id}`)).status, 404);
});

test("deleting a default passes it to the newest address; other defaults stay put", async () => {
  const first = await add();
  const second = await add();
  const third = await add({ isDefaultBilling: true });
  assert.deepEqual(await defaults(), { shipping: [first.id], billing: [third.id] });

  await api("DELETE", `/addresses/${first.id}`);
  assert.deepEqual(await defaults(), { shipping: [third.id], billing: [third.id] });

  await api("DELETE", `/addresses/${third.id}`);
  assert.deepEqual(await defaults(), { shipping: [second.id], billing: [second.id] });

  // Deleting one that isn't a default changes nothing.
  const fourth = await add();
  await api("DELETE", `/addresses/${fourth.id}`);
  assert.deepEqual(await defaults(), { shipping: [second.id], billing: [second.id] });
});

test("after the last address is deleted, the next one becomes both defaults again", async () => {
  const only = await add();
  await api("DELETE", `/addresses/${only.id}`);
  assert.deepEqual(await list(), []);
  const next = await add();
  assert.equal(next.isDefaultShipping, true);
  assert.equal(next.isDefaultBilling, true);
});

test("a user can save 20 addresses, and another after deleting one", async () => {
  let last;
  for (let i = 0; i < 20; i += 1) last = await add({ label: `A${i}` });
  const over = await api("POST", "/addresses", { body: VALID });
  assert.equal(over.status, 409);
  assert.equal(over.body.code, "ADDRESS_LIMIT_REACHED");
  assert.equal((await list()).length, 20);

  const other = await makeUser("customer", "limit@example.com");
  await add({}, other); // one user's limit doesn't affect another

  await api("DELETE", `/addresses/${last.id}`);
  await add();
});

// ---------- Requests arriving together ----------

test("parallel creates can't pass the limit, and leave one default of each kind", async () => {
  const results = await Promise.all(Array.from({ length: 25 }, () => api("POST", "/addresses", { body: VALID })));
  assert.equal(results.filter((res) => res.status === 201).length, 20);
  const refused = results.filter((res) => res.status !== 201);
  assert.ok(refused.every((res) => res.status === 409 && res.body.code === "ADDRESS_LIMIT_REACHED"));
  assert.equal((await list()).length, 20);
  const current = await defaults();
  assert.equal(current.shipping.length, 1);
  assert.equal(current.billing.length, 1);
});

test("parallel default changes all succeed and leave exactly one default", async () => {
  const addresses = [await add(), await add(), await add(), await add(), await add(), await add()];
  for (let round = 0; round < 5; round += 1) {
    const results = await Promise.all(
      addresses.map((address) =>
        api("PATCH", `/addresses/${address.id}`, { body: { isDefaultShipping: true, isDefaultBilling: true } })
      )
    );
    assert.ok(results.every((res) => res.status === 200), JSON.stringify(results.map((res) => res.status)));
    const current = await defaults();
    assert.equal(current.shipping.length, 1);
    assert.equal(current.billing.length, 1);
  }
});

test("a default survives deleting several addresses at once", async () => {
  for (let round = 0; round < 5; round += 1) {
    const addresses = [await add(), await add(), await add(), await add(), await add()];
    await Promise.all(addresses.slice(0, 4).map((address) => api("DELETE", `/addresses/${address.id}`)));
    const remaining = await list();
    assert.equal(remaining.filter((address) => address.isDefaultShipping).length, 1);
    assert.equal(remaining.filter((address) => address.isDefaultBilling).length, 1);
    await Promise.all(remaining.map((address) => api("DELETE", `/addresses/${address.id}`)));
  }
});

test("the address lock doesn't block rows that point at the user, such as a login's session", async () => {
  await db.transaction(async (client) => {
    await UserModel.lockForChange(userId, client);
    // Run from another connection while the lock is held. A stronger lock would make this wait and time out.
    await db.transaction(async (other) => {
      await other.query("SET LOCAL lock_timeout = '500ms'");
      await other.query(
        `INSERT INTO addresses (user_id, full_name, phone, address_line1, city, state, state_code, postal_code)
         VALUES ($1, 'A', '+919876543210', 'L', 'C', 'Maharashtra', '27', '411001')`,
        [userId]
      );
    });
  });
});

// ---------- A store's pickup address ----------

const GSTIN_22 = "22AAAAA0000A1Z5";
const CHHATTISGARH = { stateCode: "22", postalCode: "492001", city: "Raipur" };

let storeCounter = 0;
async function makeStore({ status = "approved", taxId = null, pickupAddressId = null } = {}) {
  storeCounter += 1;
  const { rows } = await db.query(
    `INSERT INTO seller_profiles (user_id, store_name, store_slug, legal_business_name, verification_status, tax_id, pickup_address_id)
     VALUES ($1, 'Store', $2, 'Legal', $3, $4, $5) RETURNING id`,
    [userId, `pickup-store-${storeCounter}`, status, taxId, pickupAddressId]
  );
  return rows[0].id;
}

const patchProfile = (body) => api("PATCH", "/seller/profile", { body });
const profile = async () => (await api("GET", "/seller/profile")).body.profile;

// A product ready to publish, or in the given status.
async function makeProduct(storeId, status = "draft") {
  storeCounter += 1;
  const n = storeCounter;
  const category = await db.query("INSERT INTO categories (name, slug) VALUES ($1, $1) RETURNING id", [`c-${n}`]);
  const { rows } = await db.query(
    `INSERT INTO products (seller_id, category_id, title, slug, generic_name, country_of_origin, manufacturer_name,
                           manufacturer_address, hsn_code, status)
     VALUES ($1, $2, 'Mug', $3, 'Mug', 'IN', 'Maker', '1 Road', '6912', $4) RETURNING id`,
    [storeId, category.rows[0].id, `p-${n}`, status]
  );
  await db.query(
    `INSERT INTO product_variants (product_id, seller_id, sku, mrp, selling_price, net_quantity, weight_grams,
                                   length_mm, width_mm, height_mm)
     VALUES ($1, $2, $3, 600, 300, '1 N', 300, 100, 100, 100)`,
    [rows[0].id, storeId, `S-${n}`]
  );
  await db.query(
    `INSERT INTO product_images (product_id, storage_provider, storage_key, url, is_primary)
     VALUES ($1, 'r2', $2, 'https://cdn.test/x.png', TRUE)`,
    [rows[0].id, `k-${n}`]
  );
  return rows[0].id;
}

const statusOf = async (id) => (await db.query("SELECT status FROM products WHERE id = $1", [id])).rows[0].status;
const publish = (id) => api("POST", `/seller/products/${id}/publish`);

test("a store can set its own address as pickup, but not someone else's or an unknown one", async () => {
  await makeStore();
  const mine = await add();
  const res = await patchProfile({ pickupAddressId: mine.id });
  assert.equal(res.status, 200);
  assert.equal(res.body.profile.pickupAddressId, mine.id);

  const other = await makeUser("seller", "neighbour-seller@example.com");
  const theirs = await add({}, other);
  for (const pickupAddressId of [theirs.id, MISSING_ID]) {
    const refused = await patchProfile({ pickupAddressId });
    assert.equal(refused.status, 400);
    assert.equal(refused.body.code, "INVALID_PICKUP_ADDRESS");
  }
  assert.equal((await profile()).pickupAddressId, mine.id);
});

test("a new store can name a pickup address, and it must match the GSTIN's state", async () => {
  await db.query("UPDATE users SET phone = '+919000000099', phone_verified_at = NOW() WHERE id = $1", [userId]);
  const store = { storeName: "New", storeSlug: "new-store", legalBusinessName: "Legal" };
  const pune = await add();

  const wrong = await api("POST", "/seller/profile", { body: { ...store, taxId: GSTIN_22, pickupAddressId: pune.id } });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.body.code, "PICKUP_STATE_MISMATCH");
  assert.match(wrong.body.message, /Chhattisgarh/);

  const unknown = await api("POST", "/seller/profile", { body: { ...store, pickupAddressId: MISSING_ID } });
  assert.equal(unknown.body.code, "INVALID_PICKUP_ADDRESS");
  assert.equal((await api("GET", "/seller/profile")).status, 404);

  const raipur = await add(CHHATTISGARH);
  const ok = await api("POST", "/seller/profile", { body: { ...store, taxId: GSTIN_22, pickupAddressId: raipur.id } });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.profile.pickupAddressId, raipur.id);
});

test("a store's pickup address can't be deleted until another is chosen", async () => {
  await makeStore();
  const first = await add();
  const second = await add();
  await patchProfile({ pickupAddressId: first.id });

  const refused = await api("DELETE", `/addresses/${first.id}`);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, "ADDRESS_IN_USE");
  assert.equal((await api("GET", `/addresses/${first.id}`)).status, 200);
  assert.equal((await profile()).pickupAddressId, first.id);

  await patchProfile({ pickupAddressId: second.id });
  assert.equal((await api("DELETE", `/addresses/${first.id}`)).status, 204);
  assert.equal((await profile()).pickupAddressId, second.id);
});

test("other addresses of a store can still be deleted", async () => {
  await makeStore();
  const pickup = await add();
  const other = await add();
  await patchProfile({ pickupAddressId: pickup.id });
  assert.equal((await api("DELETE", `/addresses/${other.id}`)).status, 204);
});

test("a pickup address can be cleared only while nothing is published", async () => {
  const pickup = await add();
  const store = await makeStore({ pickupAddressId: pickup.id });

  assert.equal((await patchProfile({ pickupAddressId: null })).status, 200);
  assert.equal((await patchProfile({ pickupAddressId: pickup.id })).status, 200);

  await makeProduct(store, "draft");
  assert.equal((await patchProfile({ pickupAddressId: null })).status, 200);
  await patchProfile({ pickupAddressId: pickup.id });

  for (const status of ["active", "paused"]) {
    const product = await makeProduct(store, status);
    const refused = await patchProfile({ pickupAddressId: null });
    assert.equal(refused.status, 409, status);
    assert.equal(refused.body.code, "PICKUP_ADDRESS_REQUIRED");
    assert.equal((await profile()).pickupAddressId, pickup.id);
    await db.query("UPDATE products SET deleted_at = NOW() WHERE id = $1", [product]);
  }

  // Deleted products don't count.
  assert.equal((await patchProfile({ pickupAddressId: null })).status, 200);
  await patchProfile({ pickupAddressId: pickup.id });

  // Changing to another address is always fine.
  const other = await add();
  await makeProduct(store, "active");
  assert.equal((await patchProfile({ pickupAddressId: other.id })).status, 200);
});

test("publishing needs a pickup address, listed with anything else missing", async () => {
  const store = await makeStore();
  const product = await makeProduct(store);
  await db.query("DELETE FROM product_images WHERE product_id = $1", [product]);

  const res = await publish(product);
  assert.equal(res.status, 400);
  assert.equal(res.body.code, "PRODUCT_NOT_READY");
  assert.deepEqual(res.body.details.map((detail) => detail.field).sort(), ["images", "pickupAddress"]);
  assert.equal(await statusOf(product), "draft");

  await db.query(
    `INSERT INTO product_images (product_id, storage_provider, storage_key, url, is_primary)
     VALUES ($1, 'r2', 'again', 'https://cdn.test/x.png', TRUE)`,
    [product]
  );
  await patchProfile({ pickupAddressId: (await add()).id });
  assert.equal((await publish(product)).status, 200);
  assert.equal(await statusOf(product), "active");
});

test("with a GSTIN, the pickup address must be in the same state, however either changes", async () => {
  await makeStore({ taxId: GSTIN_22 });
  const pune = await add();
  const raipur = await add(CHHATTISGARH);
  const mismatch = (res) => {
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(res.body.code, "PICKUP_STATE_MISMATCH");
  };

  // Choosing an address in another state.
  mismatch(await patchProfile({ pickupAddressId: pune.id }));
  assert.equal((await patchProfile({ pickupAddressId: raipur.id })).status, 200);

  // Moving the pickup address to another state.
  mismatch(await api("PATCH", `/addresses/${raipur.id}`, { body: { stateCode: "27" } }));
  assert.equal((await api("GET", `/addresses/${raipur.id}`)).body.address.stateCode, "22");
  assert.equal((await api("PATCH", `/addresses/${raipur.id}`, { body: { stateCode: "22", city: "Bilaspur" } })).status, 200);

  // Replacing the GSTIN with one from another state.
  mismatch(await patchProfile({ taxId: "27AAAAA0000A1Z5" }));
  assert.equal((await profile()).taxId, GSTIN_22);

  // Changing both together works.
  const both = await patchProfile({ taxId: "27AAAAA0000A1Z5", pickupAddressId: pune.id });
  assert.equal(both.status, 200);
  assert.equal(both.body.profile.taxId, "27AAAAA0000A1Z5");
});

test("adding a GSTIN must match an existing pickup address, and a refusal changes nothing", async () => {
  const pune = await add();
  const store = await makeStore({ pickupAddressId: pune.id });
  const live = await makeProduct(store, "active");

  const res = await patchProfile({ taxId: GSTIN_22 });
  assert.equal(res.body.code, "PICKUP_STATE_MISMATCH");
  assert.equal(await statusOf(live), "active"); // not returned to draft
  assert.equal((await profile()).verificationStatus, "approved");

  const fits = await patchProfile({ taxId: "27AAAAA0000A1Z5" });
  assert.equal(fits.status, 200);
  assert.equal(fits.body.productsUnpublished, 1);
});

test("without a GSTIN, or for other addresses, any state is fine", async () => {
  const pune = await add();
  const other = await add();
  await makeStore({ pickupAddressId: pune.id });
  assert.equal((await api("PATCH", `/addresses/${pune.id}`, { body: { stateCode: "29" } })).status, 200);

  await db.query("UPDATE seller_profiles SET tax_id = $1 WHERE user_id = $2", [GSTIN_22, userId]);
  assert.equal((await api("PATCH", `/addresses/${other.id}`, { body: { stateCode: "07" } })).status, 200);

  // Removing the GSTIN removes the rule.
  assert.equal((await patchProfile({ taxId: null })).status, 200);
  assert.equal((await api("PATCH", `/addresses/${pune.id}`, { body: { stateCode: "27" } })).status, 200);
});

test("an unrelated edit doesn't fail over a mismatch saved earlier", async () => {
  const pune = await add();
  await makeStore({ taxId: GSTIN_22, pickupAddressId: pune.id });
  assert.equal((await patchProfile({ description: "New" })).status, 200);
  assert.equal((await api("PATCH", `/addresses/${pune.id}`, { body: { landmark: "Near the bank" } })).status, 200);
});

test("a suspended store can't change its pickup address, but can choose defaults and use other addresses", async () => {
  const pickup = await add();
  const other = await add();
  await makeStore({ status: "suspended", pickupAddressId: pickup.id });

  const refused = await api("PATCH", `/addresses/${pickup.id}`, { body: { city: "Elsewhere" } });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, "PROFILE_SUSPENDED");
  assert.equal((await api("GET", `/addresses/${pickup.id}`)).body.address.city, "Pune");

  assert.equal((await api("PATCH", `/addresses/${pickup.id}`, { body: { isDefaultBilling: true } })).status, 200);
  assert.equal((await api("PATCH", `/addresses/${other.id}`, { body: { city: "Mumbai" } })).status, 200);
  assert.equal((await api("DELETE", `/addresses/${pickup.id}`)).status, 409);
});

test("changing a pickup address doesn't send an approved store back for review", async () => {
  const pickup = await add();
  const other = await add();
  await makeStore({ pickupAddressId: pickup.id });
  await api("PATCH", `/addresses/${pickup.id}`, { body: { city: "Mumbai" } });
  await patchProfile({ pickupAddressId: other.id });
  assert.equal((await profile()).verificationStatus, "approved");
});

test("an address and a store changing together can't end up in different states", async () => {
  const pickup = await add(CHHATTISGARH);
  await makeStore({ pickupAddressId: pickup.id });
  for (let round = 0; round < 15; round += 1) {
    const [moved, gstin] = await Promise.all([
      api("PATCH", `/addresses/${pickup.id}`, { body: { stateCode: "27" } }),
      patchProfile({ taxId: GSTIN_22 }),
    ]);
    const { rows } = await db.query(
      "SELECT s.tax_id, a.state_code FROM seller_profiles s JOIN addresses a ON a.id = s.pickup_address_id WHERE s.user_id = $1",
      [userId]
    );
    if (rows[0].tax_id) assert.equal(rows[0].tax_id.slice(0, 2), rows[0].state_code, `round ${round}: ${moved.status}/${gstin.status}`);
    await db.query("UPDATE seller_profiles SET tax_id = NULL WHERE user_id = $1", [userId]);
    await db.query("UPDATE addresses SET state_code = '22', state = 'Chhattisgarh' WHERE id = $1", [pickup.id]);
  }
});

test("deleting an address while choosing it as pickup can't leave the store pointing at nothing", async () => {
  await makeStore();
  const keep = await add();
  for (let round = 0; round < 15; round += 1) {
    await patchProfile({ pickupAddressId: keep.id });
    const address = await add();
    const [chosen, deleted] = await Promise.all([
      patchProfile({ pickupAddressId: address.id }),
      api("DELETE", `/addresses/${address.id}`),
    ]);
    assert.equal(
      [chosen.status, deleted.status].sort().join(),
      deleted.status === 204 ? "204,400" : "200,409",
      `round ${round}: ${chosen.status}/${deleted.status}`
    );
    const current = (await profile()).pickupAddressId;
    assert.equal(current, chosen.status === 200 ? address.id : keep.id, `round ${round}`);
    if (chosen.status === 200) {
      await patchProfile({ pickupAddressId: keep.id });
      await api("DELETE", `/addresses/${address.id}`);
    }
  }
});

test("creating a store while deleting its pickup address can't both succeed", async () => {
  await db.query("UPDATE users SET phone = '+919000000098', phone_verified_at = NOW() WHERE id = $1", [userId]);
  const store = { storeName: "New", storeSlug: "race-store", legalBusinessName: "Legal" };
  for (let round = 0; round < 30; round += 1) {
    const address = await add();
    const [created, deleted] = await Promise.all([
      api("POST", "/seller/profile", { body: { ...store, pickupAddressId: address.id } }),
      api("DELETE", `/addresses/${address.id}`),
    ]);
    assert.equal(
      [created.status, deleted.status].sort().join(),
      created.status === 201 ? "201,409" : "204,400",
      `round ${round}: create ${created.status}, delete ${deleted.status}`
    );
    await db.query("DELETE FROM seller_profiles WHERE user_id = $1", [userId]);
    await db.query("DELETE FROM addresses WHERE user_id = $1", [userId]);
  }
});

test("clearing a pickup address while publishing can't leave a live product without one", async () => {
  const pickup = await add();
  const store = await makeStore({ pickupAddressId: pickup.id });
  for (let round = 0; round < 15; round += 1) {
    const product = await makeProduct(store);
    const [published, cleared] = await Promise.all([publish(product), patchProfile({ pickupAddressId: null })]);
    const current = await profile();
    assert.ok(
      (await statusOf(product)) === "draft" || current.pickupAddressId,
      `round ${round}: publish ${published.status}, clear ${cleared.status}`
    );
    await db.query("UPDATE products SET status = 'draft', deleted_at = NOW() WHERE id = $1", [product]);
    await patchProfile({ pickupAddressId: pickup.id });
  }
});

// ---------- Who sees a store's pickup address ----------

async function publicPage(productId) {
  const { rows } = await db.query("SELECT slug FROM products WHERE id = $1", [productId]);
  return { slug: rows[0].slug, page: await api("GET", `/products/${rows[0].slug}`, { as: null }) };
}

test("the seller sees the full pickup address on every profile response", async () => {
  await db.query("UPDATE users SET phone = '+919000000097', phone_verified_at = NOW() WHERE id = $1", [userId]);
  const address = await add({ landmark: "Near the bank" });

  const created = await api("POST", "/seller/profile", {
    body: { storeName: "S", storeSlug: "shown-store", legalBusinessName: "L", pickupAddressId: address.id },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.profile.pickupAddress.id, address.id);
  assert.equal(created.body.profile.pickupAddress.fullName, "Asha Rao");

  const read = await profile();
  assert.deepEqual(read.pickupAddress, (await api("GET", `/addresses/${address.id}`)).body.address);
  assert.equal(read.pickupAddressId, address.id);

  const other = await add({ city: "Mumbai" });
  const changed = await patchProfile({ pickupAddressId: other.id });
  assert.equal(changed.body.profile.pickupAddress.city, "Mumbai");

  const cleared = await patchProfile({ pickupAddressId: null });
  assert.equal(cleared.body.profile.pickupAddress, null);
  assert.equal((await profile()).pickupAddress, null);
});

test("an edit to the address shows on the profile straight away", async () => {
  const address = await add();
  await makeStore({ pickupAddressId: address.id });
  await api("PATCH", `/addresses/${address.id}`, { body: { city: "Nagpur" } });
  assert.equal((await profile()).pickupAddress.city, "Nagpur");
});

test("admins see each store's own full pickup address in review", async () => {
  const admin = await makeUser("admin", "reviewer@example.com");
  const pickup = await add({ city: "Pune" });
  const mine = await makeStore({ status: "pending", pickupAddressId: pickup.id });

  const secondToken = await makeUser("seller", "second-store@example.com");
  const secondAddress = await add({ city: "Delhi", stateCode: "07", postalCode: "110001" }, secondToken);
  const { rows } = await db.query("SELECT user_id FROM addresses WHERE id = $1", [secondAddress.id]);
  const second = await db.query(
    `INSERT INTO seller_profiles (user_id, store_name, store_slug, legal_business_name, pickup_address_id)
     VALUES ($1, 'Second', 'second-store', 'L', $2) RETURNING id`,
    [rows[0].user_id, secondAddress.id]
  );
  await makeUser("seller", "third-store@example.com");
  const third = await db.query(
    `INSERT INTO seller_profiles (user_id, store_name, store_slug, legal_business_name)
     SELECT id, 'Third', 'third-store', 'L' FROM users WHERE email = 'third-store@example.com' RETURNING id`
  );

  const list = await api("GET", "/admin/sellers?status=pending", { as: admin });
  assert.equal(list.status, 200);
  const byId = new Map(list.body.profiles.map((row) => [row.id, row]));
  assert.equal(byId.get(mine).pickupAddress.city, "Pune");
  assert.equal(byId.get(mine).pickupAddress.phone, "+919876543210");
  assert.equal(byId.get(mine).pickupAddress.fullName, "Asha Rao");
  assert.equal(byId.get(second.rows[0].id).pickupAddress.city, "Delhi");
  assert.equal(byId.get(second.rows[0].id).pickupAddress.stateCode, "07");
  assert.equal(byId.get(third.rows[0].id).pickupAddress, null);

  const decided = await api("PATCH", `/admin/sellers/${mine}/verification`, { as: admin, body: { status: "approved" } });
  assert.equal(decided.status, 200);
  assert.equal(decided.body.profile.pickupAddress.city, "Pune");
});

test("the admin list works with no stores at all", async () => {
  const admin = await makeUser("admin", "empty-reviewer@example.com");
  const res = await api("GET", "/admin/sellers?status=pending", { as: admin });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.profiles, []);
});

test("customers see the seller's location on the product page, but not the contact name or phone", async () => {
  await add({ addressLine1: "Home, not the pickup address", city: "Goa" }); // an older address must not be shown
  const pickup = await add({ fullName: "Private Person", phone: "+919111111111", addressLine2: "Camp", landmark: "Near the bank" });
  const store = await makeStore({ pickupAddressId: pickup.id });
  const product = await makeProduct(store, "active");

  const { page } = await publicPage(product);
  assert.equal(page.status, 200);
  assert.deepEqual(page.body.product.seller.address, {
    addressLine1: "12 MG Road",
    addressLine2: "Camp",
    landmark: "Near the bank",
    city: "Pune",
    state: "Maharashtra",
    postalCode: "411001",
    countryCode: "IN",
  });
  const json = JSON.stringify(page.body);
  assert.equal(json.includes("Private Person"), false);
  assert.equal(json.includes("+919111111111"), false);
  assert.equal(json.includes(pickup.id), false);
  assert.equal(json.includes("isDefault"), false);
  assert.equal(page.body.product.seller.pickupAddress, undefined);
});

test("the product list doesn't include the seller's address", async () => {
  const pickup = await add();
  const store = await makeStore({ pickupAddressId: pickup.id });
  await makeProduct(store, "active");
  const list = await api("GET", "/products", { as: null });
  assert.equal(list.body.pagination.total, 1);
  assert.equal(JSON.stringify(list.body).includes("MG Road"), false);
});

test("the product page follows the store's current address, and a hidden product shows nothing", async () => {
  const pickup = await add();
  const store = await makeStore({ pickupAddressId: pickup.id });
  const product = await makeProduct(store, "active");

  await api("PATCH", `/addresses/${pickup.id}`, { body: { city: "Nagpur" } });
  assert.equal((await publicPage(product)).page.body.product.seller.address.city, "Nagpur");

  const paused = await makeProduct(store, "paused");
  const hidden = (await publicPage(paused)).page;
  assert.equal(hidden.status, 404);
  assert.equal(JSON.stringify(hidden.body).includes("MG Road"), false);
});

test("a product published before the rule, with no pickup address, still has a page", async () => {
  const store = await makeStore();
  const product = await makeProduct(store, "active");
  const { page } = await publicPage(product);
  assert.equal(page.status, 200);
  assert.equal(page.body.product.seller.address, null);
});
