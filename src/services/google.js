const { OAuth2Client } = require("google-auth-library");
const env = require("../config/env");
const ApiError = require("../utils/ApiError");

const client = new OAuth2Client();

// Checks the signature, expiry and that the token was issued for this app.
async function verifyIdToken(idToken) {
  if (!env.GOOGLE_CLIENT_ID) {
    throw new ApiError(503, "Google login is not configured", { code: "GOOGLE_NOT_CONFIGURED" });
  }

  let payload;
  try {
    const ticket = await client.verifyIdToken({ idToken, audience: env.GOOGLE_CLIENT_ID });
    payload = ticket.getPayload();
  } catch {
    throw new ApiError(401, "Invalid Google token", { code: "INVALID_GOOGLE_TOKEN" });
  }

  return {
    providerUserId: payload.sub,
    email: payload.email?.toLowerCase(),
    emailVerified: payload.email_verified === true,
    name: payload.name,
    avatarUrl: payload.picture,
  };
}

module.exports = { verifyIdToken };
