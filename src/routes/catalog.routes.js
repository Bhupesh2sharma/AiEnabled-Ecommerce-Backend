// Public URLs: /api/categories, /api/brands, /api/products and /api/states. No login needed.

const { Router } = require("express");
const address = require("../controllers/address.controller");
const brand = require("../controllers/brand.controller");
const browse = require("../controllers/browse.controller");
const category = require("../controllers/category.controller");
const limit = require("../middlewares/rateLimit");
const validate = require("../middlewares/validate");
const asyncHandler = require("../utils/asyncHandler");
const { idParam, brandQuery, browseProducts, productSlugParam } = require("../validators/catalog.validator");

const router = Router();

router.use(limit.publicRead);

router.get("/categories", asyncHandler(category.getTree));
router.get("/categories/:id/variant-options", validate(idParam, "params"), asyncHandler(category.getVariantOptions));
router.get("/brands", validate(brandQuery, "query"), asyncHandler(brand.list));
router.get("/states", address.listStates);
router.get("/products", validate(browseProducts, "query"), asyncHandler(browse.list));
router.get("/products/:slug", validate(productSlugParam, "params"), asyncHandler(browse.getOne));

module.exports = router;
