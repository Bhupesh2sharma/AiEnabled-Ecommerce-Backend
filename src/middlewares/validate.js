const ApiError = require("../utils/ApiError");

// Validates req.body, req.params or req.query against a zod schema and replaces it with the
// parsed value. defineProperty because req.query is a getter in Express 5.
const validate = (schema, source = "body") => (req, res, next) => {
  const result = schema.safeParse(req[source] ?? {});
  if (!result.success) {
    throw new ApiError(400, "Validation failed", {
      code: "VALIDATION_ERROR",
      details: result.error.issues.map((issue) => ({
        field: issue.path.join("."),
        message: issue.message,
      })),
    });
  }
  Object.defineProperty(req, source, { value: result.data, writable: true, configurable: true });
  next();
};

module.exports = validate;
