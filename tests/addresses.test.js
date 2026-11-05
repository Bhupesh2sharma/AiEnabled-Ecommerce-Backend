// Tests of the addresses table and state list against a real Postgres.
// TEST_DATABASE_URL must point at a migrated, disposable database: its data is deleted.

const { after, beforeEach, test } = require("node:test");
const assert = require("node:assert/strict");

require("./testEnv");

const db = require("../src/config/db");
const { INDIAN_STATES } = require("../src/utils/indianStates");

after(() => db.pool.end());

let userId;

beforeEach(async () => {
  await db.query("TRUNCATE users CASCADE");
  const { rows } = await db.query(
    `INSERT INTO users (name, email, role, email_verified_at, terms_accepted_at, terms_version)
     VALUES ('Test', 'address@example.com', 'seller', NOW(), NOW(), 'v1') RETURNING id`
  );
  userId = rows[0].id;
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
