// SQL for auth_providers: links a user to an external login such as Google.

const db = require("../config/db");

// Returns the live user linked to this identity, if any.
async function findUser(provider, providerUserId, client = db) {
  const { rows } = await client.query(
    `SELECT u.*
     FROM auth_providers ap
     JOIN users u ON u.id = ap.user_id
     WHERE ap.provider = $1 AND ap.provider_user_id = $2 AND u.deleted_at IS NULL`,
    [provider, providerUserId]
  );
  return rows[0] ?? null;
}

// Only called after findUser found no live user, so a conflict here is a link
// left behind by a soft-deleted account and can be moved to the new one.
async function link({ userId, provider, providerUserId }, client = db) {
  await client.query(
    `INSERT INTO auth_providers (user_id, provider, provider_user_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (provider, provider_user_id) DO UPDATE SET user_id = EXCLUDED.user_id`,
    [userId, provider, providerUserId]
  );
}

module.exports = { findUser, link };
