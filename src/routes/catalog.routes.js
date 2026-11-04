// Public catalog URLs: /api/categories and /api/brands. No login needed.

const { Router } = require("express");
const brand = require("../controllers/brand.controller");
const category = require("../controllers/category.controller");
const limit = require("../middlewares/rateLimit");
const validate = require("../middlewares/validate");
const asyncHandler = require("../utils/asyncHandler");
const { idParam, brandQuery } = require("../validators/catalog.validator");

const router = Router();

router.use(limit.publicRead);

router.get("/categories", asyncHandler(category.getTree));
router.get("/categories/:id/variant-options", validate(idParam, "params"), asyncHandler(category.getVariantOptions));
router.get("/brands", validate(brandQuery, "query"), asyncHandler(brand.list));

module.exports = router;
