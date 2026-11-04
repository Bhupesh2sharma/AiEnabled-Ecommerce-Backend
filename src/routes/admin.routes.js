const { Router } = require("express");
const admin = require("../controllers/admin.controller");
const { authenticate, authorize } = require("../middlewares/auth");
const validate = require("../middlewares/validate");
const asyncHandler = require("../utils/asyncHandler");
const { sellerIdParam, listSellers, sellerDecision } = require("../validators/admin.validator");
const { createAdmin } = require("../validators/auth.validator");

const router = Router();

router.use(asyncHandler(authenticate), authorize("admin"));

router.post("/admins", validate(createAdmin), asyncHandler(admin.createAdmin));

router.get("/sellers", validate(listSellers, "query"), asyncHandler(admin.listSellers));
router.patch(
  "/sellers/:id/verification",
  validate(sellerIdParam, "params"),
  validate(sellerDecision),
  asyncHandler(admin.decideSeller)
);

module.exports = router;
