const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const env = require("../config/env");

const JWT_ALGORITHM = "HS256";

function signAccessToken(user) {
  return jwt.sign({ role: user.role }, env.JWT_ACCESS_SECRET, {
    subject: user.id,
    algorithm: JWT_ALGORITHM,
    expiresIn: env.JWT_ACCESS_EXPIRES_IN,
  });
}

const verifyAccessToken = (token) =>
  jwt.verify(token, env.JWT_ACCESS_SECRET, { algorithms: [JWT_ALGORITHM] });

const generateRefreshToken = () => crypto.randomBytes(32).toString("base64url");

const hashRefreshToken = (token) => crypto.createHash("sha256").update(token).digest("hex");

module.exports = { signAccessToken, verifyAccessToken, generateRefreshToken, hashRefreshToken };
