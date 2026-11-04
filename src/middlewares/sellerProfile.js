// Product endpoints work on the seller's store, so they need a store profile.
// Sellers awaiting approval can prepare drafts; publishing requires approval (step 7).

const SellerProfileModel = require("../models/sellerProfile.model");
const ApiError = require("../utils/ApiError");

// Use after authorize("seller"). Sets req.sellerProfile.
async function loadSellerProfile(req, res, next) {
  const profile = await SellerProfileModel.findByUserId(req.user.id);
  if (!profile) {
    throw new ApiError(403, "Create your store profile first", { code: "SELLER_PROFILE_REQUIRED" });
  }
  req.sellerProfile = profile;
  next();
}

// Suspended sellers can still see their products, but can't change them.
function requireNotSuspended(req, res, next) {
  if (req.sellerProfile.verification_status === "suspended") {
    throw new ApiError(403, "Your store is suspended", { code: "PROFILE_SUSPENDED" });
  }
  next();
}

module.exports = { loadSellerProfile, requireNotSuspended };
