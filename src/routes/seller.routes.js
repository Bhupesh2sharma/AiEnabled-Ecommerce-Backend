// URLs under /api/seller. Every route here requires a seller login.

const { Router } = require("express");
const seller = require("../controllers/seller.controller");
const { authenticate, authorize } = require("../middlewares/auth");
const validate = require("../middlewares/validate");
const asyncHandler = require("../utils/asyncHandler");
const { createProfile, updateProfile } = require("../validators/seller.validator");

const router = Router();

router.use(asyncHandler(authenticate), authorize("seller"));

router.post("/profile", validate(createProfile), asyncHandler(seller.createProfile));
router.get("/profile", asyncHandler(seller.getProfile));
router.patch("/profile", validate(updateProfile), asyncHandler(seller.updateProfile));

module.exports = router;
