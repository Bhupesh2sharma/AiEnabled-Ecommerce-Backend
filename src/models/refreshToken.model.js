const db = require("../config/db");
const env = require("../config/env");

async function create({ userId, tokenHash, userAgent }, client = db) {
  await client.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, user_agent, expires_at)
     VALUES ($1, $2, $3, NOW() + make_interval(days => $4))`,
    [userId, tokenHash, userAgent, env.REFRESH_TOKEN_EXPIRES_DAYS]
  );
}

// Atomically revokes a live token and returns it, so a token can only be rotated once.
async function revokeIfActive(tokenHash, client = db) {
  const { rows } = await client.query(
    `UPDATE refresh_tokens SET revoked_at = NOW()
     WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > NOW()
     RETURNING *`,
    [tokenHash]
  );
  return rows[0] ?? null;
}

async function revokeAllForUser(userId, client = db) {
  await client.query(
    "UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL",
    [userId]
  );
}

async function purgeExpiredForUser(userId, client = db) {
  await client.query("DELETE FROM refresh_tokens WHERE user_id = $1 AND expires_at < NOW()", [userId]);
}

module.exports = { create, revokeIfActive, revokeAllForUser, purgeExpiredForUser };
