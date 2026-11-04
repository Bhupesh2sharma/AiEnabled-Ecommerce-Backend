const db = require("../config/db");

async function lockTarget(target, client) {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [target]);
}

async function getSendStats({ channel, target, purpose }, client = db) {
  const { rows } = await client.query(
    `SELECT EXTRACT(EPOCH FROM NOW() - MAX(created_at))::float AS seconds_since_last,
            COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '1 hour')::int AS sent_last_hour
     FROM otp_codes
     WHERE channel = $1 AND target = $2 AND purpose = $3`,
    [channel, target, purpose]
  );
  return rows[0];
}

async function purgeOld({ channel, target, purpose }, client = db) {
  await client.query(
    `DELETE FROM otp_codes
     WHERE channel = $1 AND target = $2 AND purpose = $3 AND created_at < NOW() - INTERVAL '1 day'`,
    [channel, target, purpose]
  );
}

async function consumeActive({ channel, target, purpose }, client = db) {
  await client.query(
    `UPDATE otp_codes SET consumed_at = NOW()
     WHERE channel = $1 AND target = $2 AND purpose = $3 AND consumed_at IS NULL`,
    [channel, target, purpose]
  );
}

async function create({ channel, target, purpose, codeHash, expiresMinutes }, client = db) {
  const { rows } = await client.query(
    `INSERT INTO otp_codes (channel, target, purpose, code_hash, expires_at)
     VALUES ($1, $2, $3, $4, NOW() + make_interval(mins => $5))
     RETURNING *`,
    [channel, target, purpose, codeHash, expiresMinutes]
  );
  return rows[0];
}

async function remove(id) {
  await db.query("DELETE FROM otp_codes WHERE id = $1", [id]);
}

async function findActive({ channel, target, purpose }) {
  const { rows } = await db.query(
    `SELECT * FROM otp_codes
     WHERE channel = $1 AND target = $2 AND purpose = $3
       AND consumed_at IS NULL AND expires_at > NOW()
     ORDER BY created_at DESC
     LIMIT 1`,
    [channel, target, purpose]
  );
  return rows[0] ?? null;
}

// Returns false once the code has no attempts left.
async function countAttempt(id, maxAttempts) {
  const { rowCount } = await db.query(
    "UPDATE otp_codes SET attempts = attempts + 1 WHERE id = $1 AND attempts < $2",
    [id, maxAttempts]
  );
  return rowCount === 1;
}

// Returns false if the code was already used.
async function consume(id) {
  const { rowCount } = await db.query(
    "UPDATE otp_codes SET consumed_at = NOW() WHERE id = $1 AND consumed_at IS NULL",
    [id]
  );
  return rowCount === 1;
}

module.exports = {
  lockTarget,
  getSendStats,
  purgeOld,
  consumeActive,
  create,
  remove,
  findActive,
  countAttempt,
  consume,
};
