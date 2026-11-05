// SQL for the users table. Soft-deleted users are never returned by the find functions.

const db = require("../config/db");
const env = require("../config/env");

const LOCK_AFTER_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;

// Only these fields ever leave the API.
function toPublicUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    avatarUrl: user.avatar_url,
    role: user.role,
    status: user.status,
    emailVerified: user.email_verified_at !== null,
    phoneVerified: user.phone_verified_at !== null,
    hasPassword: user.password_hash !== null,
    createdAt: user.created_at,
  };
}

// The find and create functions take an optional client so they can run inside a transaction.
async function findById(id, client = db) {
  const { rows } = await client.query("SELECT * FROM users WHERE id = $1 AND deleted_at IS NULL", [id]);
  return rows[0] ?? null;
}

async function findByEmail(email, client = db) {
  const { rows } = await client.query(
    "SELECT * FROM users WHERE LOWER(email) = LOWER($1) AND deleted_at IS NULL",
    [email]
  );
  return rows[0] ?? null;
}

async function findByPhone(phone, client = db) {
  const { rows } = await client.query("SELECT * FROM users WHERE phone = $1 AND deleted_at IS NULL", [phone]);
  return rows[0] ?? null;
}

// Creates a user of any role. Terms are recorded as accepted now, with the current terms version,
// so callers must check termsAccepted before calling this.
async function create(
  {
    name,
    email = null,
    phone = null,
    avatarUrl = null,
    passwordHash = null,
    role = "customer",
    emailVerified = false,
    phoneVerified = false,
    marketingOptIn = false,
  },
  client = db
) {
  const { rows } = await client.query(
    `INSERT INTO users (
       name, email, phone, avatar_url, password_hash, role,
       email_verified_at, phone_verified_at,
       terms_accepted_at, terms_version, marketing_opt_in
     )
     VALUES (
       $1, $2, $3, $4, $5, $6,
       CASE WHEN $7::boolean THEN NOW() END, CASE WHEN $8::boolean THEN NOW() END,
       NOW(), $9, $10
     )
     RETURNING *`,
    [name, email, phone, avatarUrl, passwordHash, role, emailVerified, phoneVerified, env.TERMS_VERSION, marketingOptIn]
  );
  return rows[0];
}

// Counts a failed password. The fifth failure locks the account and restarts the count.
async function recordFailedLogin(id) {
  await db.query(
    `UPDATE users
     SET locked_until = CASE WHEN failed_login_count + 1 >= $2
                             THEN NOW() + make_interval(mins => $3) ELSE locked_until END,
         failed_login_count = CASE WHEN failed_login_count + 1 >= $2 THEN 0 ELSE failed_login_count + 1 END
     WHERE id = $1`,
    [id, LOCK_AFTER_FAILED_LOGINS, LOCK_MINUTES]
  );
}

// Called on every successful login: saves the time and clears any failed attempts and lock.
async function recordLogin(id, client = db) {
  await client.query(
    "UPDATE users SET last_login_at = NOW(), failed_login_count = 0, locked_until = NULL WHERE id = $1",
    [id]
  );
}

// COALESCE keeps the original verification time if the email was already verified.
async function markEmailVerified(id, client = db) {
  const { rows } = await client.query(
    "UPDATE users SET email_verified_at = COALESCE(email_verified_at, NOW()) WHERE id = $1 RETURNING *",
    [id]
  );
  return rows[0];
}

// Someone just proved they own an email that was never verified. Any password on the account
// was set by whoever registered it, who may not be the owner, so it stops working.
async function claimUnverifiedEmail(id, client = db) {
  const { rows } = await client.query(
    "UPDATE users SET email_verified_at = NOW(), password_hash = NULL WHERE id = $1 RETURNING *",
    [id]
  );
  return rows[0];
}

// Resetting a password proves ownership of the email, so it also verifies it and clears any lock.
async function resetPassword(id, passwordHash, client = db) {
  await client.query(
    `UPDATE users
     SET password_hash = $2, email_verified_at = COALESCE(email_verified_at, NOW()),
         failed_login_count = 0, locked_until = NULL
     WHERE id = $1`,
    [id, passwordHash]
  );
}

// A phone is only saved after its OTP is checked, so a stored phone is always verified.
async function setVerifiedPhone(id, phone) {
  const { rows } = await db.query(
    "UPDATE users SET phone = $2, phone_verified_at = NOW() WHERE id = $1 RETURNING *",
    [id, phone]
  );
  return rows[0];
}

// Used by logged-in accounts after their email OTP is checked.
async function setVerifiedEmail(id, email) {
  const { rows } = await db.query(
    "UPDATE users SET email = $2, email_verified_at = NOW() WHERE id = $1 RETURNING *",
    [id, email]
  );
  return rows[0];
}

// Used by scripts/create-admin.js, which only creates the first admin.
async function adminExists() {
  const { rows } = await db.query(
    "SELECT EXISTS (SELECT 1 FROM users WHERE role = 'admin' AND deleted_at IS NULL) AS exists"
  );
  return rows[0].exists;
}

// Holds the user until the transaction ends, so limits on what a user owns, such as addresses and cart
// items, stay correct when requests arrive together. NO KEY UPDATE, because a stronger lock would block
// the user's logins, which insert rows pointing at this one.
async function lockForChange(userId, client) {
  await client.query("SELECT 1 FROM users WHERE id = $1 FOR NO KEY UPDATE", [userId]);
}

module.exports = {
  toPublicUser,
  findById,
  findByEmail,
  findByPhone,
  create,
  recordFailedLogin,
  recordLogin,
  markEmailVerified,
  claimUnverifiedEmail,
  resetPassword,
  setVerifiedPhone,
  setVerifiedEmail,
  adminExists,
  lockForChange,
};
