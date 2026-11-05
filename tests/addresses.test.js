// Tests of the address book, the addresses table and the state list against a real Postgres.
// TEST_DATABASE_URL must point at a migrated, disposable database: its data is deleted.

const { after, before, beforeEach, test } = require("node:test");
const assert = require("node:assert/strict");

require("./testEnv");

const app = require("../src/app");
const db = require("../src/config/db");
const AddressModel = require("../src/models/address.model");
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
  await db.query("TRUNCATE users CASCADE");
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
    await AddressModel.lockUser(userId, client);
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
