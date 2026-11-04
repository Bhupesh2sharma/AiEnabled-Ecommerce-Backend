const env = require("../config/env");

const PG_UNIQUE_VIOLATION = "23505";

const UNIQUE_MESSAGES = {
  users_email_unique: "An account with this email already exists",
  users_phone_unique: "An account with this phone number already exists",
  auth_providers_user_provider_unique: "A different Google account is already linked to this account",
  seller_profiles_store_slug_unique: "This store URL is already taken",
  seller_profiles_user_id_key: "A seller profile already exists for this account",
};

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (err.code === PG_UNIQUE_VIOLATION) {
    return res.status(409).json({
      message: UNIQUE_MESSAGES[err.constraint] || "This record already exists",
      code: "CONFLICT",
    });
  }

  const status = err.status || 500;
  if (status >= 500) console.error(err);

  // Unexpected errors can carry internal details, so only development sees their message.
  const message =
    status < 500 || err.name === "ApiError" || env.NODE_ENV === "development"
      ? err.message
      : "Internal Server Error";

  res.status(status).json({
    message,
    ...(typeof err.code === "string" && err.name === "ApiError" && { code: err.code }),
    ...(err.details && { details: err.details }),
    ...(env.NODE_ENV === "development" && status >= 500 && { stack: err.stack }),
  });
}

module.exports = errorHandler;
