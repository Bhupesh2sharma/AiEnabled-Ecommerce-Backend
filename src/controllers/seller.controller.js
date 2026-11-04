// Seller onboarding. Admin review of the profile is in admin.controller.js.

const SellerProfileModel = require("../models/sellerProfile.model");
const ApiError = require("../utils/ApiError");

// Google verifies the email at signup and phone OTP verifies the phone, so each signup method
// leaves at most the other one to do.
function assertContactsVerified(user) {
  const details = [];
  if (!user.email_verified_at) details.push({ field: "email", message: "Verify your email" });
  if (!user.phone_verified_at) details.push({ field: "phone", message: "Verify your phone number" });
  if (details.length > 0) {
    throw new ApiError(403, "Verify your email and phone number first", {
      code: "SELLER_VERIFICATION_REQUIRED",
      details,
    });
  }
}

// POST /api/seller/profile: creates the store profile, which starts as `pending`.
async function createProfile(req, res) {
  assertContactsVerified(req.user);

  const { pickupAddressId } = req.body;
  if (pickupAddressId && !(await SellerProfileModel.userOwnsAddress(req.user.id, pickupAddressId))) {
    throw new ApiError(400, "Pickup address not found", { code: "INVALID_PICKUP_ADDRESS" });
  }

  const profile = await SellerProfileModel.create(req.user.id, req.body);
  res.status(201).json({ profile: SellerProfileModel.toPublicProfile(profile) });
}

module.exports = { createProfile };
