// URLs under /api/seller. Every route here requires a seller login.

const { Router } = require("express");
const seller = require("../controllers/seller.controller");
const { authenticate, authorize } = require("../middlewares/auth");
const validate = require("../middlewares/validate");
const asyncHandler = require("../utils/asyncHandler");
const { createProfile } = require("../validators/seller.validator");

const router = Router();

router.use(asyncHandler(authenticate), authorize("seller"));

router.post("/profile", validate(createProfile), asyncHandler(seller.createProfile));

module.exports = router;
