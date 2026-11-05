// SQL for addresses. Users only reach their own: every lookup here includes the user's id.

const db = require("../config/db");
const buildAssignments = require("../utils/sqlUpdate");

const COLUMNS = {
  label: "label",
  fullName: "full_name",
  phone: "phone",
  addressLine1: "address_line1",
  addressLine2: "address_line2",
  landmark: "landmark",
  city: "city",
  state: "state",
  stateCode: "state_code",
  postalCode: "postal_code",
  isDefaultShipping: "is_default_shipping",
  isDefaultBilling: "is_default_billing",
};

// Only these two columns can be passed to clearDefault and promoteNewest.
const DEFAULT_COLUMNS = { shipping: "is_default_shipping", billing: "is_default_billing" };

function toAddress(address) {
  return {
    id: address.id,
    label: address.label,
    fullName: address.full_name,
    phone: address.phone,
    addressLine1: address.address_line1,
    addressLine2: address.address_line2,
    landmark: address.landmark,
    city: address.city,
    state: address.state,
    stateCode: address.state_code,
    postalCode: address.postal_code,
    countryCode: address.country_code,
    isDefaultShipping: address.is_default_shipping,
    isDefaultBilling: address.is_default_billing,
    createdAt: address.created_at,
    updatedAt: address.updated_at,
  };
}

// Holds the user until the transaction ends, so the limit and the defaults stay correct when requests
// arrive together. NO KEY UPDATE, because a stronger lock would block the user's logins, which insert
// rows pointing at this one.
async function lockUser(userId, client) {
  await client.query("SELECT 1 FROM users WHERE id = $1 FOR NO KEY UPDATE", [userId]);
}

async function listForUser(userId) {
  const { rows } = await db.query(
    `SELECT * FROM addresses WHERE user_id = $1
     ORDER BY is_default_shipping DESC, is_default_billing DESC, created_at DESC, id DESC`,
    [userId]
  );
  return rows;
}

async function countForUser(userId, client) {
  const { rows } = await client.query("SELECT COUNT(*)::int AS count FROM addresses WHERE user_id = $1", [userId]);
  return rows[0].count;
}

async function findOwned(id, userId, client = db) {
  const { rows } = await client.query("SELECT * FROM addresses WHERE id = $1 AND user_id = $2", [id, userId]);
  return rows[0] ?? null;
}

async function create(userId, fields, client) {
  const { rows } = await client.query(
    `INSERT INTO addresses (
       user_id, label, full_name, phone, address_line1, address_line2, landmark, city, state, state_code,
       postal_code, is_default_shipping, is_default_billing
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING *`,
    [
      userId,
      fields.label ?? null,
      fields.fullName,
      fields.phone,
      fields.addressLine1,
      fields.addressLine2 ?? null,
      fields.landmark ?? null,
      fields.city,
      fields.state,
      fields.stateCode,
      fields.postalCode,
      fields.isDefaultShipping,
      fields.isDefaultBilling,
    ]
  );
  return rows[0];
}

async function update(id, fields, client) {
  const { assignments, values } = buildAssignments(fields, COLUMNS);
  const { rows } = await client.query(`UPDATE addresses SET ${assignments} WHERE id = $1 RETURNING *`, [id, ...values]);
  return rows[0];
}

// A user can have only one default of each kind, so the old one must be cleared first.
async function clearDefault(userId, kind, client) {
  const column = DEFAULT_COLUMNS[kind];
  await client.query(`UPDATE addresses SET ${column} = FALSE WHERE user_id = $1 AND ${column}`, [userId]);
}

async function remove(id, client) {
  await client.query("DELETE FROM addresses WHERE id = $1", [id]);
}

// After a default is deleted, the most recently added address takes over. Does nothing if none are left.
async function promoteNewest(userId, kind, client) {
  const column = DEFAULT_COLUMNS[kind];
  await client.query(
    `UPDATE addresses SET ${column} = TRUE
     WHERE id = (SELECT id FROM addresses WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1)`,
    [userId]
  );
}

module.exports = { toAddress, lockUser, listForUser, countForUser, findOwned, create, update, clearDefault, remove, promoteNewest };
