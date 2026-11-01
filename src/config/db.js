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

module.exports = {
  pool,
  connectDB,
  query: (text, params) => pool.query(text, params),
};
