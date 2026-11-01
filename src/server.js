const app = require("./app");
const env = require("./config/env");
const { connectDB, pool } = require("./config/db");

async function start() {
  try {
    await connectDB();
  } catch (err) {
    console.error("Failed to connect to Postgres:", err.message);
    process.exit(1);
  }

  const server = app.listen(env.PORT, () => {
    console.log(`Server running on http://localhost:${env.PORT}`);
  });

  const shutdown = () => {
    server.close(async () => {
      await pool.end();
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

start();
