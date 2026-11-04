const db = require("../config/db");
const AuthProviderModel = require("../models/authProvider.model");
const RefreshTokenModel = require("../models/refreshToken.model");
const UserModel = require("../models/user.model");
const google = require("../services/google");
const ApiError = require("../utils/ApiError");
const { assertActive, startSession } = require("../utils/session");

const PROVIDER = "google";

function assertGoogleAllowed(user) {
  if (user.role === "admin") {
    throw new ApiError(403, "Admins cannot log in with Google", { code: "METHOD_NOT_ALLOWED" });
  }
  assertActive(user);
}

async function login(req, res) {
  const { idToken, role, termsAccepted, marketingOptIn } = req.body;
  const identity = await google.verifyIdToken(idToken);

  // An unverified Google email proves nothing, so it must not match or create an account.
  if (!identity.email || !identity.emailVerified) {
    throw new ApiError(401, "Your Google email is not verified", { code: "GOOGLE_EMAIL_UNVERIFIED" });
  }

  const { providerUserId, email } = identity;
  const { user, created } = await db.transaction(async (client) => {
    const linked = await AuthProviderModel.findUser(PROVIDER, providerUserId, client);
    if (linked) {
      assertGoogleAllowed(linked);
      return { user: linked, created: false };
    }

    const existing = await UserModel.findByEmail(email, client);
    if (existing) {
      assertGoogleAllowed(existing);
      await AuthProviderModel.link({ userId: existing.id, provider: PROVIDER, providerUserId }, client);
      if (existing.email_verified_at) return { user: existing, created: false };

      await RefreshTokenModel.revokeAllForUser(existing.id, client);
      return { user: await UserModel.claimUnverifiedEmail(existing.id, client), created: false };
    }

    if (!termsAccepted) {
      throw new ApiError(400, "You must accept the terms to create an account", { code: "TERMS_REQUIRED" });
    }
    const newUser = await UserModel.create(
      {
        name: identity.name?.slice(0, 100) || email.split("@")[0].slice(0, 100),
        email,
        role,
        marketingOptIn,
        avatarUrl: identity.avatarUrl,
        emailVerified: true,
      },
      client
    );
    await AuthProviderModel.link({ userId: newUser.id, provider: PROVIDER, providerUserId }, client);
    return { user: newUser, created: true };
  });

  res.status(created ? 201 : 200).json(await startSession(req, res, user));
}

module.exports = { login };
