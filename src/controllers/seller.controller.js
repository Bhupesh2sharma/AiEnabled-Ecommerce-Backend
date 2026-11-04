// Seller onboarding. Admin review of the profile is in admin.controller.js.

const db = require("../config/db");
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

// Changing any of these on an approved profile needs a fresh admin review, otherwise a seller
// could get approved and then swap in a different business.
const LEGAL_FIELDS = [
  ["businessType", "business_type"],
  ["legalBusinessName", "legal_business_name"],
  ["taxId", "tax_id"],
];

const profileNotFound = () => new ApiError(404, "Seller profile not found", { code: "NOT_FOUND" });

async function assertOwnsPickupAddress(userId, addressId) {
  if (addressId && !(await SellerProfileModel.userOwnsAddress(userId, addressId))) {
    throw new ApiError(400, "Pickup address not found", { code: "INVALID_PICKUP_ADDRESS" });
  }
}

// POST /api/seller/profile: creates the store profile, which starts as `pending`.
async function createProfile(req, res) {
  assertContactsVerified(req.user);

  await assertOwnsPickupAddress(req.user.id, req.body.pickupAddressId);

  const profile = await SellerProfileModel.create(req.user.id, req.body);
  res.status(201).json({ profile: SellerProfileModel.toPublicProfile(profile) });
}

// GET /api/seller/profile: shows the seller their profile, approval status and any rejection reason.
async function getProfile(req, res) {
  const profile = await SellerProfileModel.findByUserId(req.user.id);
  if (!profile) throw profileNotFound();
  res.json({ profile: SellerProfileModel.toPublicProfile(profile) });
}

// PATCH /api/seller/profile: edits the profile. Editing a rejected profile sends it back for review,
// as does changing legal details on an approved one. Suspended profiles can't be edited.
async function updateProfile(req, res) {
  await assertOwnsPickupAddress(req.user.id, req.body.pickupAddressId);

  const updated = await db.transaction(async (client) => {
    // The lock stops an admin's decision landing between this check and the update.
    const profile = await SellerProfileModel.findByUserIdForUpdate(req.user.id, client);
    if (!profile) throw profileNotFound();

    if (profile.verification_status === "suspended") {
      throw new ApiError(409, "A suspended profile can't be edited", { code: "PROFILE_SUSPENDED" });
    }

    const legalChanged = LEGAL_FIELDS.some(
      ([field, column]) => req.body[field] !== undefined && req.body[field] !== profile[column]
    );
    const needsReview =
      profile.verification_status === "rejected" ||
      (profile.verification_status === "approved" && legalChanged);

    return SellerProfileModel.update(profile.id, req.body, { resetReview: needsReview }, client);
  });

  res.json({ profile: SellerProfileModel.toPublicProfile(updated) });
}

module.exports = { createProfile, getProfile, updateProfile };
