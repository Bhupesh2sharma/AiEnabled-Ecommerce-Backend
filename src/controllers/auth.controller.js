const db = require("../config/db");
const RefreshTokenModel = require("../models/refreshToken.model");
const UserModel = require("../models/user.model");
const { issueOtpInBackground } = require("../services/otp.service");
const ApiError = require("../utils/ApiError");
const { hashPassword, verifyPassword } = require("../utils/password");
const {
  REFRESH_COOKIE,
  setRefreshCookie,
  clearRefreshCookie,
  assertActive,
  createRefreshToken,
  startSession,
} = require("../utils/session");
const { signAccessToken, hashRefreshToken } = require("../utils/token");

async function signup(req, res) {
  const { name, email, password, role, marketingOptIn } = req.body;

  // Hashing is slow, so check first. The unique index still catches a race (see errorHandler).
  if (await UserModel.findByEmail(email)) {
    throw new ApiError(409, "An account with this email already exists", { code: "CONFLICT" });
  }

  const user = await UserModel.create({
    name,
    email,
    role,
    marketingOptIn,
    passwordHash: await hashPassword(password),
  });
  issueOtpInBackground({ channel: "email", target: email, purpose: "verify_email" });

  res.status(201).json(await startSession(req, res, user));
}

async function login(req, res) {
  const { email, password } = req.body;
  const user = await UserModel.findByEmail(email);

  if (user?.locked_until && user.locked_until > new Date()) {
    throw new ApiError(429, "Too many failed attempts. Try again later", { code: "ACCOUNT_LOCKED" });
  }

  if (!(await verifyPassword(password, user?.password_hash))) {
    if (user) await UserModel.recordFailedLogin(user.id);
    throw new ApiError(401, "Incorrect email or password", { code: "INVALID_CREDENTIALS" });
  }

  assertActive(user);
  res.json(await startSession(req, res, user));
}

// Swaps the refresh token for a new one and issues a new access token.
async function refresh(req, res) {
  const token = req.cookies[REFRESH_COOKIE];
  const rejected = () => {
    clearRefreshCookie(res);
    return new ApiError(401, "Session expired. Please log in again", { code: "INVALID_REFRESH_TOKEN" });
  };
  if (!token) throw rejected();

  const { user, newToken } = await db.transaction(async (client) => {
    const stored = await RefreshTokenModel.revokeIfActive(hashRefreshToken(token), client);
    if (!stored) throw rejected();

    const owner = await UserModel.findById(stored.user_id, client);
    if (!owner || owner.status !== "active") throw rejected();

    return { user: owner, newToken: await createRefreshToken(req, owner.id, client) };
  });

  setRefreshCookie(res, newToken);
  res.json({ user: UserModel.toPublicUser(user), accessToken: signAccessToken(user) });
}

async function logout(req, res) {
  const token = req.cookies[REFRESH_COOKIE];
  if (token) await RefreshTokenModel.revokeIfActive(hashRefreshToken(token));
  clearRefreshCookie(res);
  res.status(204).end();
}

async function logoutAll(req, res) {
  await RefreshTokenModel.revokeAllForUser(req.user.id);
  clearRefreshCookie(res);
  res.status(204).end();
}

function me(req, res) {
  res.json({ user: UserModel.toPublicUser(req.user) });
}

module.exports = { signup, login, refresh, logout, logoutAll, me };
