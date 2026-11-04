const { Router } = require("express");
const adminRoutes = require("./admin.routes");
const authRoutes = require("./auth.routes");
const healthRoutes = require("./health.routes");
const sellerRoutes = require("./seller.routes");

const router = Router();

router.use("/health", healthRoutes);
router.use("/auth", authRoutes);
router.use("/seller", sellerRoutes);
router.use("/admin", adminRoutes);

module.exports = router;
