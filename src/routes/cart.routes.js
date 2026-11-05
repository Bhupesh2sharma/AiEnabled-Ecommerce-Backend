// URLs under /api/cart. Only customers have a cart: accounts have one role, so a seller who wants to
// buy needs a separate customer account, which also stops sellers ordering their own products.

const { Router } = require("express");
const cart = require("../controllers/cart.controller");
const { authenticate, authorize } = require("../middlewares/auth");
const validate = require("../middlewares/validate");
const asyncHandler = require("../utils/asyncHandler");
const { addItem } = require("../validators/cart.validator");

const router = Router();

router.use(asyncHandler(authenticate), authorize("customer"));

router.get("/", asyncHandler(cart.getCart));
router.post("/items", validate(addItem), asyncHandler(cart.addItem));

module.exports = router;
