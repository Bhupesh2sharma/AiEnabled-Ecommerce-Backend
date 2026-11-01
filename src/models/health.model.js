const db = require("../config/db");

async function checkDatabase() {
  const { rows } = await db.query("SELECT NOW() AS now");
  return rows[0].now;
}

module.exports = { checkDatabase };
