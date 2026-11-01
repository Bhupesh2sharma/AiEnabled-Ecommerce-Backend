const HealthModel = require("../models/health.model");

async function getHealth(req, res) {
  const health = {
    status: "ok",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    database: "connected",
  };

  try {
    await HealthModel.checkDatabase();
    res.status(200).json(health);
  } catch (err) {
    res.status(503).json({ ...health, status: "error", database: "disconnected" });
  }
}

module.exports = { getHealth };
