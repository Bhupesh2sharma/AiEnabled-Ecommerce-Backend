// Creates and checks access tokens (JWT) and refresh tokens (random values).

const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const env = require("../config/env");

const JWT_ALGORITHM = "HS256";

// The token holds the user id (sub) and role, and is valid for JWT_ACCESS_EXPIRES_IN.
function signAccessToken(user) {
  return jwt.sign({ role: user.role }, env.JWT_ACCESS_SECRET, {
    subject: user.id,
    algorithm: JWT_ALGORITHM,
    expiresIn: env.JWT_ACCESS_EXPIRES_IN,
  });
}

// Throws if the token is invalid or expired. Only HS256 is accepted, which rejects forged `alg` values.
const verifyAccessToken = (token) =>
  jwt.verify(token, env.JWT_ACCESS_SECRET, { algorithms: [JWT_ALGORITHM] });

const generateRefreshToken = () => crypto.randomBytes(32).toString("base64url");

// The cookie holds the token and the database holds this hash, so a database leak exposes no sessions.
const hashRefreshToken = (token) => crypto.createHash("sha256").update(token).digest("hex");

module.exports = { signAccessToken, verifyAccessToken, generateRefreshToken, hashRefreshToken };
