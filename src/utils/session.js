// Shared login logic: the refresh cookie and starting a session.

const db = require("../config/db");
const env = require("../config/env");
const RefreshTokenModel = require("../models/refreshToken.model");
const UserModel = require("../models/user.model");
const ApiError = require("./ApiError");
const { signAccessToken, generateRefreshToken, hashRefreshToken } = require("./token");

const REFRESH_COOKIE = "refreshToken";

// Lax means the frontend and API must share a site in production (e.g. shop.com + api.shop.com).
const cookieOptions = {
  httpOnly: true,
  secure: env.NODE_ENV === "production",
  sameSite: "lax",
  path: "/api/auth",
};

function setRefreshCookie(res, token) {
  res.cookie(REFRESH_COOKIE, token, {
    ...cookieOptions,
    maxAge: env.REFRESH_TOKEN_EXPIRES_DAYS * 24 * 60 * 60 * 1000,
  });
}

function clearRefreshCookie(res) {
  res.clearCookie(REFRESH_COOKIE, cookieOptions);
}

// Suspended and inactive accounts can't log in.
function assertActive(user) {
  if (user.status !== "active") {
    throw new ApiError(403, "This account is not active", { code: "ACCOUNT_INACTIVE" });
  }
}

// Creates a refresh token and stores its hash. Returns the plain token for the cookie.
async function createRefreshToken(req, userId, client) {
  const token = generateRefreshToken();
  await RefreshTokenModel.create(
    { userId, tokenHash: hashRefreshToken(token), userAgent: req.get("user-agent") ?? null },
    client
  );
  return token;
}

// Logs the user in: records the login, stores a refresh token and sets its cookie.
async function startSession(req, res, user) {
  const refreshToken = await db.transaction(async (client) => {
    await UserModel.recordLogin(user.id, client);
    await RefreshTokenModel.purgeExpiredForUser(user.id, client);
    return createRefreshToken(req, user.id, client);
  });
  setRefreshCookie(res, refreshToken);
  return { user: UserModel.toPublicUser(user), accessToken: signAccessToken(user) };
}

module.exports = {
  REFRESH_COOKIE,
  setRefreshCookie,
  clearRefreshCookie,
  assertActive,
  createRefreshToken,
  startSession,
};
