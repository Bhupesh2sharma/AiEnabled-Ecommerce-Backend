// Turns every error into the API's JSON error format: { message, code?, details? }.

const env = require("../config/env");

const PG_UNIQUE_VIOLATION = "23505";
// Postgres 18 raises 23001 for ON DELETE RESTRICT, and 23503 for other foreign key failures.
const PG_REFERENCE_VIOLATIONS = new Set(["23001", "23503"]);

// Friendly messages for duplicates caught by the database, keyed by constraint name.
const UNIQUE_MESSAGES = {
  users_email_unique: "An account with this email already exists",
  users_phone_unique: "An account with this phone number already exists",
  auth_providers_user_provider_unique: "A different Google account is already linked to this account",
  seller_profiles_store_slug_unique: "This store URL is already taken",
  seller_profiles_user_id_key: "A seller profile already exists for this account",
  categories_slug_unique: "This category URL is already taken",
  categories_sibling_name_unique: "A category with this name already exists here",
  brands_name_unique: "A brand with this name already exists",
  brands_slug_unique: "This brand URL is already taken",
  variant_options_code_unique: "A variant option with this code already exists",
  variant_option_values_code_unique: "This option already has a value with this code",
};

// Express treats a middleware with four parameters as the error handler.
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (err.code === PG_UNIQUE_VIOLATION) {
    return res.status(409).json({
      message: UNIQUE_MESSAGES[err.constraint] || "This record already exists",
      code: "CONFLICT",
    });
  }

  if (PG_REFERENCE_VIOLATIONS.has(err.code)) {
    return res.status(409).json({
      message: "This record is linked to other data, so the change can't be made",
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
