const env = require("../config/env");

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const status = err.status || 500;
  console.error(err);
  res.status(status).json({
    message: err.message || "Internal Server Error",
    ...(env.NODE_ENV === "development" && { stack: err.stack }),
  });
}

module.exports = errorHandler;
