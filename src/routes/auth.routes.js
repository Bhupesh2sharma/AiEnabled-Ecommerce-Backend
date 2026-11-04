const { Router } = require("express");
const auth = require("../controllers/auth.controller");
const google = require("../controllers/google.controller");
const otp = require("../controllers/otp.controller");
const { authenticate } = require("../middlewares/auth");
const limit = require("../middlewares/rateLimit");
const validate = require("../middlewares/validate");
const asyncHandler = require("../utils/asyncHandler");
const schemas = require("../validators/auth.validator");

const router = Router();

// Limits run first, so invalid requests count too.
router.use(limit.general);

router.post("/signup", limit.signup, validate(schemas.emailSignup), asyncHandler(auth.signup));
router.post("/login", limit.credentials, validate(schemas.emailLogin), asyncHandler(auth.login));
router.post("/refresh", asyncHandler(auth.refresh));
router.post("/logout", asyncHandler(auth.logout));
router.post("/logout-all", asyncHandler(authenticate), asyncHandler(auth.logoutAll));
router.get("/me", asyncHandler(authenticate), auth.me);

router.post("/otp/send", limit.otpSend, validate(schemas.otpSend), asyncHandler(otp.send));
router.post("/otp/verify-email", limit.credentials, validate(schemas.verifyEmail), asyncHandler(otp.verifyEmail));
router.post("/otp/login", limit.credentials, validate(schemas.otpLogin), asyncHandler(otp.login));
router.post("/password/reset", limit.credentials, validate(schemas.resetPassword), asyncHandler(otp.resetPassword));

router.post(
  "/phone/send-verification",
  limit.otpSend,
  asyncHandler(authenticate),
  validate(schemas.phoneSendVerification),
  asyncHandler(otp.sendPhoneVerification)
);
router.post(
  "/phone/verify",
  limit.credentials,
  asyncHandler(authenticate),
  validate(schemas.phoneVerify),
  asyncHandler(otp.verifyPhone)
);

router.post("/google", limit.credentials, validate(schemas.googleLogin), asyncHandler(google.login));

module.exports = router;
