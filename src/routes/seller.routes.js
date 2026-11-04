// URLs under /api/seller. Every route here requires a seller login.

const { Router } = require("express");
const image = require("../controllers/image.controller");
const product = require("../controllers/product.controller");
const seller = require("../controllers/seller.controller");
const stock = require("../controllers/stock.controller");
const { authenticate, authorize } = require("../middlewares/auth");
const limit = require("../middlewares/rateLimit");
const { loadSellerProfile, requireNotSuspended } = require("../middlewares/sellerProfile");
const validate = require("../middlewares/validate");
const asyncHandler = require("../utils/asyncHandler");
const schemas = require("../validators/product.validator");
const { createProfile, updateProfile } = require("../validators/seller.validator");

const router = Router();

router.use(asyncHandler(authenticate), authorize("seller"));

router.post("/profile", validate(createProfile), asyncHandler(seller.createProfile));
router.get("/profile", asyncHandler(seller.getProfile));
router.patch("/profile", validate(updateProfile), asyncHandler(seller.updateProfile));

// Runs before validation, so a seller with no store sees that rather than field errors.
const canRead = asyncHandler(loadSellerProfile);
const canWrite = [canRead, requireNotSuspended];
const idParam = validate(schemas.idParam, "params");

router.post("/products", canWrite, validate(schemas.createProduct), asyncHandler(product.createProduct));
router.get("/products", canRead, validate(schemas.listProducts, "query"), asyncHandler(product.listProducts));
router.get("/products/:id", canRead, idParam, asyncHandler(product.getProduct));
router.patch("/products/:id", canWrite, idParam, validate(schemas.updateProduct), asyncHandler(product.updateProduct));
router.delete("/products/:id", canWrite, idParam, asyncHandler(product.deleteProduct));

router.post(
  "/products/:id/variants",
  canWrite,
  idParam,
  validate(schemas.createVariant),
  asyncHandler(product.createVariant)
);
router.patch("/variants/:id", canWrite, idParam, validate(schemas.updateVariant), asyncHandler(product.updateVariant));
router.delete("/variants/:id", canWrite, idParam, asyncHandler(product.deleteVariant));

router.post("/variants/:id/stock", canWrite, idParam, validate(schemas.changeStock), asyncHandler(stock.changeStock));
router.get(
  "/variants/:id/stock-movements",
  canRead,
  idParam,
  validate(schemas.paging, "query"),
  asyncHandler(stock.listMovements)
);

router.post(
  "/uploads/signature",
  limit.uploads,
  canWrite,
  validate(schemas.createUpload),
  asyncHandler(image.createSellerUpload)
);
router.post("/products/:id/images", canWrite, idParam, validate(schemas.attachImage), asyncHandler(image.attachImage));
router.patch("/images/:id", canWrite, idParam, validate(schemas.updateImage), asyncHandler(image.updateImage));
router.delete("/images/:id", canWrite, idParam, asyncHandler(image.deleteImage));

module.exports = router;
