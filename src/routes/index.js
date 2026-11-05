const { Router } = require("express");
const addressRoutes = require("./address.routes");
const adminRoutes = require("./admin.routes");
const authRoutes = require("./auth.routes");
const cartRoutes = require("./cart.routes");
const catalogRoutes = require("./catalog.routes");
const healthRoutes = require("./health.routes");
const sellerRoutes = require("./seller.routes");

const router = Router();

router.use("/health", healthRoutes);
router.use("/auth", authRoutes);
router.use("/addresses", addressRoutes);
router.use("/cart", cartRoutes);
router.use("/seller", sellerRoutes);
router.use("/admin", adminRoutes);
router.use(catalogRoutes);

module.exports = router;
