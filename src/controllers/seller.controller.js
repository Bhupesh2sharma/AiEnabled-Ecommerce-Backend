// Seller onboarding. Admin review of the profile is in admin.controller.js.

const db = require("../config/db");
const AddressModel = require("../models/address.model");
const ProductModel = require("../models/product.model");
const SellerProfileModel = require("../models/sellerProfile.model");
const UserModel = require("../models/user.model");
const ApiError = require("../utils/ApiError");
const { assertPickupMatchesGstin } = require("../utils/gst");

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

async function findOwnPickupAddress(userId, addressId, client) {
  const address = await AddressModel.findOwned(addressId, userId, client);
  if (!address) throw new ApiError(400, "Pickup address not found", { code: "INVALID_PICKUP_ADDRESS" });
  return address;
}

// A profile as its seller sees it, with the pickup address in full.
async function toSellerResponse(profile) {
  const [pickup] = profile.pickup_address_id ? await AddressModel.listByIds([profile.pickup_address_id]) : [];
  return { ...SellerProfileModel.toPublicProfile(profile), pickupAddress: pickup ? AddressModel.toAddress(pickup) : null };
}

// Checks a profile edit leaves the store with a valid pickup address. Only runs on what's changing,
// so an unrelated edit can't fail over something saved earlier.
async function checkPickupChange(userId, profile, { pickupAddressId, taxId }, client) {
  if (pickupAddressId === undefined && taxId === undefined) return;

  if (pickupAddressId === null && (await ProductModel.hasPublished(profile.id, client))) {
    throw new ApiError(409, "Published products need a pickup address. Choose another instead", {
      code: "PICKUP_ADDRESS_REQUIRED",
    });
  }

  const newTaxId = taxId === undefined ? profile.tax_id : taxId;
  const newPickupId = pickupAddressId === undefined ? profile.pickup_address_id : pickupAddressId;
  if (newPickupId) {
    const address = await findOwnPickupAddress(userId, newPickupId, client);
    if (newTaxId) assertPickupMatchesGstin(newTaxId, address.state_code);
  }
}

// POST /api/seller/profile: creates the store profile, which starts as `pending`.
async function createProfile(req, res) {
  assertContactsVerified(req.user);

  const profile = await db.transaction(async (client) => {
    // The address can't be deleted or moved to another state while this lock is held.
    await UserModel.lockForChange(req.user.id, client);
    if (req.body.pickupAddressId) {
      const address = await findOwnPickupAddress(req.user.id, req.body.pickupAddressId, client);
      if (req.body.taxId) assertPickupMatchesGstin(req.body.taxId, address.state_code);
    }
    return SellerProfileModel.create(req.user.id, req.body, client);
  });
  res.status(201).json({ profile: await toSellerResponse(profile) });
}

// GET /api/seller/profile: shows the seller their profile, approval status and any rejection reason.
async function getProfile(req, res) {
  const profile = await SellerProfileModel.findByUserId(req.user.id);
  if (!profile) throw profileNotFound();
  res.json({ profile: await toSellerResponse(profile) });
}

// PATCH /api/seller/profile: edits the profile. Editing a rejected profile sends it back for review,
// as does changing legal details on an approved one. Suspended profiles can't be edited.
async function updateProfile(req, res) {
  const { updated, productsUnpublished } = await db.transaction(async (client) => {
    // Always the user, then the profile, then products: the order address changes and publishing use.
    await UserModel.lockForChange(req.user.id, client);
    // The lock stops an admin's decision landing between this check and the update.
    const profile = await SellerProfileModel.findByUserIdForUpdate(req.user.id, client);
    if (!profile) throw profileNotFound();

    if (profile.verification_status === "suspended") {
      throw new ApiError(409, "A suspended profile can't be edited", { code: "PROFILE_SUSPENDED" });
    }

    await checkPickupChange(req.user.id, profile, req.body, client);

    const legalChanged = LEGAL_FIELDS.some(
      ([field, column]) => req.body[field] !== undefined && req.body[field] !== profile[column]
    );
    const needsReview =
      profile.verification_status === "rejected" ||
      (profile.verification_status === "approved" && legalChanged);

    // Gaining or losing a GSTIN changes the tax on every product, so they must be re-published
    // with the right HSN codes and GST rates. A new GSTIN number on its own doesn't change that.
    const { taxId } = req.body;
    const gstinChanged = taxId !== undefined && Boolean(taxId) !== Boolean(profile.tax_id);
    const unpublished = gstinChanged ? await ProductModel.unpublishAll(profile.id, client) : 0;

    return {
      updated: await SellerProfileModel.update(profile.id, req.body, { resetReview: needsReview }, client),
      productsUnpublished: unpublished,
    };
  });

  res.json({ profile: await toSellerResponse(updated), productsUnpublished });
}

module.exports = { createProfile, getProfile, updateProfile };
