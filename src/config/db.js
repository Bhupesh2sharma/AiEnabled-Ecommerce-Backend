const { Pool } = require("pg");
const env = require("./env");

const pool = new Pool({ connectionString: env.DATABASE_URL });

pool.on("error", (err) => {
  console.error("Unexpected Postgres pool error:", err);
});

async function connectDB() {
  const client = await pool.connect();
  client.release();
  console.log("Connected to Postgres");
}

// Runs fn(client) in a transaction. Pass client to the model functions it calls.
async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  pool,
  connectDB,
  transaction,
  query: (text, params) => pool.query(text, params),
};
