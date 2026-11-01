// Runs SQL migrations from src/db/migrations in filename order.
// Each file runs once inside a transaction and is recorded in schema_migrations.
//
//   npm run migrate                 apply all pending migrations
//   npm run migrate:status          list applied / pending migrations
//   npm run migrate:create <name>   create a new empty migration file

const fs = require("fs");
const path = require("path");

const MIGRATIONS_DIR = path.join(__dirname, "..", "src", "db", "migrations");

function listMigrationFiles() {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith(".sql"))
    .sort();
}

async function getAppliedMigrations(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  const { rows } = await pool.query("SELECT name FROM schema_migrations");
  return new Set(rows.map((row) => row.name));
}

async function migrate(pool) {
  const applied = await getAppliedMigrations(pool);
  const pending = listMigrationFiles().filter((file) => !applied.has(file));

  if (pending.length === 0) {
    console.log("No pending migrations.");
    return;
  }

  for (const file of pending) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
      await client.query("COMMIT");
      console.log(`Applied  ${file}`);
    } catch (err) {
      await client.query("ROLLBACK");
      throw new Error(`Migration ${file} failed: ${err.message}`);
    } finally {
      client.release();
    }
  }
}

async function status(pool) {
  const applied = await getAppliedMigrations(pool);
  for (const file of listMigrationFiles()) {
    console.log(`${applied.has(file) ? "applied" : "pending"}  ${file}`);
  }
}

function create(name) {
  if (!name) {
    throw new Error("Usage: npm run migrate:create <name>");
  }
  const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  const file = path.join(MIGRATIONS_DIR, `${stamp}_${slug}.sql`);
  fs.writeFileSync(file, `-- ${name}\n\n`);
  console.log(`Created  ${path.relative(process.cwd(), file)}`);
}

async function main() {
  const [command = "up", name] = process.argv.slice(2);

  if (command === "create") {
    create(name);
    return;
  }

  const { pool } = require("../src/config/db");
  try {
    if (command === "up") await migrate(pool);
    else if (command === "status") await status(pool);
    else throw new Error(`Unknown command: ${command}`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
