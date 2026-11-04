// An error that is safe to show to the client. `code` is a stable value the frontend can switch on.
class ApiError extends Error {
  constructor(status, message, { code, details } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

module.exports = ApiError;
