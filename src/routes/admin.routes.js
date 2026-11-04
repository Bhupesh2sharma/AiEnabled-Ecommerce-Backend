// URLs under /api/admin. Every route here requires an admin login.

const { Router } = require("express");
const admin = require("../controllers/admin.controller");
const brand = require("../controllers/brand.controller");
const category = require("../controllers/category.controller");
const variantOption = require("../controllers/variantOption.controller");
const { authenticate, authorize } = require("../middlewares/auth");
const validate = require("../middlewares/validate");
const asyncHandler = require("../utils/asyncHandler");
const { sellerIdParam, listSellers, sellerDecision } = require("../validators/admin.validator");
const { createAdmin } = require("../validators/auth.validator");
const catalog = require("../validators/catalog.validator");

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

router.get("/categories", asyncHandler(category.adminList));
router.post("/categories", validate(catalog.createCategory), asyncHandler(category.create));
router.patch(
  "/categories/:id",
  validate(catalog.idParam, "params"),
  validate(catalog.updateCategory),
  asyncHandler(category.update)
);
router.delete("/categories/:id", validate(catalog.idParam, "params"), asyncHandler(category.remove));
router.put(
  "/categories/:id/variant-options",
  validate(catalog.idParam, "params"),
  validate(catalog.setCategoryOptions),
  asyncHandler(category.setVariantOptions)
);

router.get("/brands", validate(catalog.brandQuery, "query"), asyncHandler(brand.adminList));
router.post("/brands", validate(catalog.createBrand), asyncHandler(brand.create));
router.patch(
  "/brands/:id",
  validate(catalog.idParam, "params"),
  validate(catalog.updateBrand),
  asyncHandler(brand.update)
);
router.delete("/brands/:id", validate(catalog.idParam, "params"), asyncHandler(brand.remove));

router.get("/variant-options", asyncHandler(variantOption.list));
router.post("/variant-options", validate(catalog.createOption), asyncHandler(variantOption.create));
router.patch(
  "/variant-options/:id",
  validate(catalog.idParam, "params"),
  validate(catalog.updateOption),
  asyncHandler(variantOption.update)
);
router.delete("/variant-options/:id", validate(catalog.idParam, "params"), asyncHandler(variantOption.remove));
router.post(
  "/variant-options/:id/values",
  validate(catalog.idParam, "params"),
  validate(catalog.createValue),
  asyncHandler(variantOption.createValue)
);
router.patch(
  "/variant-options/:id/values/:valueId",
  validate(catalog.valueParams, "params"),
  validate(catalog.updateValue),
  asyncHandler(variantOption.updateValue)
);
router.delete(
  "/variant-options/:id/values/:valueId",
  validate(catalog.valueParams, "params"),
  asyncHandler(variantOption.removeValue)
);

module.exports = router;
