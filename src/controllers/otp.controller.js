const db = require("../config/db");
const RefreshTokenModel = require("../models/refreshToken.model");
const UserModel = require("../models/user.model");
const {
  RESEND_COOLDOWN_SECONDS,
  issueOtp,
  issueOtpInBackground,
  checkOtp,
  consumeOtp,
  verifyOtp,
  invalidCode,
} = require("../services/otp.service");
const ApiError = require("../utils/ApiError");
const { hashPassword } = require("../utils/password");
const { assertActive, clearRefreshCookie, startSession } = require("../utils/session");

// Whether a public OTP request should really send a code.
function shouldSend({ channel, purpose }, user) {
  if (channel === "phone") {
    // Unknown phone numbers get a code because phone login also signs up. Admins can't use phone.
    return !user || (user.status === "active" && user.role !== "admin");
  }
  if (!user || user.status !== "active") return false;
  return purpose !== "verify_email" || user.email_verified_at === null;
}

// The response is the same whether or not a code was sent, so this can't be used
// to find out which emails and phone numbers have accounts.
async function send(req, res) {
  const { channel, target, purpose } = req.body;
  const user =
    channel === "email" ? await UserModel.findByEmail(target) : await UserModel.findByPhone(target);

  if (shouldSend({ channel, purpose }, user)) {
    issueOtpInBackground({ channel, target, purpose });
  }

  res.json({
    message: "If this request is valid, a code has been sent",
    resendAfterSeconds: RESEND_COOLDOWN_SECONDS,
  });
}

async function verifyEmail(req, res) {
  const { email, code } = req.body;
  await verifyOtp({ channel: "email", target: email, purpose: "verify_email", code });

  const user = await UserModel.findByEmail(email);
  if (!user) throw invalidCode();

  const updated = await UserModel.markEmailVerified(user.id);
  res.json({ user: UserModel.toPublicUser(updated) });
}

async function loginWithEmail(req, res, otp) {
  const user = await UserModel.findByEmail(req.body.target);
  if (!user) throw invalidCode();
  assertActive(user);
  await consumeOtp(otp);

  if (user.email_verified_at) return res.json(await startSession(req, res, user));

  const claimed = await db.transaction(async (client) => {
    await RefreshTokenModel.revokeAllForUser(user.id, client);
    return UserModel.claimUnverifiedEmail(user.id, client);
  });
  res.json(await startSession(req, res, claimed));
}

async function loginWithPhone(req, res, otp) {
  const { target: phone, name, role, termsAccepted, marketingOptIn } = req.body;
  const user = await UserModel.findByPhone(phone);

  if (user) {
    if (user.role === "admin") throw invalidCode();
    assertActive(user);
    await consumeOtp(otp);
    return res.json(await startSession(req, res, user));
  }

  // The code is left unused so the client can resend it with the signup details.
  if (!name || !termsAccepted) {
    throw new ApiError(400, "Name and terms acceptance are required to create an account", {
      code: "SIGNUP_DETAILS_REQUIRED",
    });
  }

  await consumeOtp(otp);
  const created = await UserModel.create({ name, phone, role, marketingOptIn, phoneVerified: true });
  res.status(201).json(await startSession(req, res, created));
}

async function login(req, res) {
  const { channel, target, code } = req.body;
  const otp = await checkOtp({ channel, target, purpose: "login", code });
  return channel === "email" ? loginWithEmail(req, res, otp) : loginWithPhone(req, res, otp);
}

async function resetPassword(req, res) {
  const { email, code, newPassword } = req.body;
  await verifyOtp({ channel: "email", target: email, purpose: "reset_password", code });

  const user = await UserModel.findByEmail(email);
  if (!user) throw invalidCode();

  const passwordHash = await hashPassword(newPassword);
  await db.transaction(async (client) => {
    await UserModel.resetPassword(user.id, passwordHash, client);
    await RefreshTokenModel.revokeAllForUser(user.id, client);
  });

  clearRefreshCookie(res);
  res.json({ message: "Password updated. Please log in again" });
}

// Adding a phone to an existing account. Requires login, so the errors don't need hiding.
async function sendPhoneVerification(req, res) {
  const { phone } = req.body;
  const owner = await UserModel.findByPhone(phone);
  if (owner) {
    throw new ApiError(409, "An account with this phone number already exists", { code: "CONFLICT" });
  }
  await issueOtp({ channel: "phone", target: phone, purpose: "verify_phone" });
  res.json({ message: "Code sent", resendAfterSeconds: RESEND_COOLDOWN_SECONDS });
}

async function verifyPhone(req, res) {
  const { phone, code } = req.body;
  await verifyOtp({ channel: "phone", target: phone, purpose: "verify_phone", code });
  const updated = await UserModel.setVerifiedPhone(req.user.id, phone);
  res.json({ user: UserModel.toPublicUser(updated) });
}

module.exports = { send, verifyEmail, login, resetPassword, sendPhoneVerification, verifyPhone };
