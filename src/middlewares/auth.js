const UserModel = require("../models/user.model");
const ApiError = require("../utils/ApiError");
const { verifyAccessToken } = require("../utils/token");

const unauthorized = () => new ApiError(401, "Authentication required", { code: "UNAUTHORIZED" });

// Loads the user on every request, so suspensions and role changes apply straight away
// rather than when the 15-minute access token expires.
async function authenticate(req, res, next) {
  const [scheme, token] = (req.get("authorization") ?? "").split(" ");
  if (scheme !== "Bearer" || !token) throw unauthorized();

  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch {
    throw unauthorized();
  }

  const user = await UserModel.findById(payload.sub);
  if (!user || user.status !== "active") throw unauthorized();

  req.user = user;
  next();
}

// Use after authenticate: authorize("admin") or authorize("seller", "admin").
const authorize = (...roles) => (req, res, next) => {
  if (!roles.includes(req.user.role)) {
    throw new ApiError(403, "You do not have access to this resource", { code: "FORBIDDEN" });
  }
  next();
};

module.exports = { authenticate, authorize };
