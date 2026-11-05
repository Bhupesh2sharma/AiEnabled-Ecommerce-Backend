// URLs under /api/addresses. Customers and sellers have address books; admins don't buy or sell.

const { Router } = require("express");
const address = require("../controllers/address.controller");
const { authenticate, authorize } = require("../middlewares/auth");
const validate = require("../middlewares/validate");
const asyncHandler = require("../utils/asyncHandler");
const { createAddress, updateAddress, idParam } = require("../validators/address.validator");

const router = Router();

router.use(asyncHandler(authenticate), authorize("customer", "seller"));

router.get("/", asyncHandler(address.list));
router.post("/", validate(createAddress), asyncHandler(address.create));
router.get("/:id", validate(idParam, "params"), asyncHandler(address.getOne));
router.patch("/:id", validate(idParam, "params"), validate(updateAddress), asyncHandler(address.update));
router.delete("/:id", validate(idParam, "params"), asyncHandler(address.remove));

module.exports = router;
