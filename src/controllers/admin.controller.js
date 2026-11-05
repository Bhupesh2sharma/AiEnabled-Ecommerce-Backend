// Admin-only actions. admin.routes.js requires an admin login for everything here.

const AddressModel = require("../models/address.model");
const SellerProfileModel = require("../models/sellerProfile.model");
const UserModel = require("../models/user.model");
const ApiError = require("../utils/ApiError");
const { hashPassword } = require("../utils/password");

// The creating admin vouches for the email, so it starts verified.
async function createAdmin(req, res) {
  const { name, email, password } = req.body;
  const user = await UserModel.create({
    name,
    email,
    role: "admin",
    emailVerified: true,
    passwordHash: await hashPassword(password),
  });
  res.status(201).json({ user: UserModel.toPublicUser(user) });
}

// Profiles with their pickup addresses in full, so admins can check them against the GSTIN during review.
async function toAdminResponses(profiles) {
  const ids = profiles.map((profile) => profile.pickup_address_id).filter(Boolean);
  const addresses = new Map((await AddressModel.listByIds(ids)).map((address) => [address.id, address]));
  return profiles.map((profile) => {
    const pickup = addresses.get(profile.pickup_address_id);
    return { ...SellerProfileModel.toAdminProfile(profile), pickupAddress: pickup ? AddressModel.toAddress(pickup) : null };
  });
}

// GET /api/admin/sellers: lists seller profiles by status.
async function listSellers(req, res) {
  const profiles = await SellerProfileModel.listByStatus(req.query.status);
  res.json({ profiles: await toAdminResponses(profiles) });
}

// PATCH /api/admin/sellers/:id/verification: approves or rejects a seller profile.
async function decideSeller(req, res) {
  const { id } = req.params;
  const { status, reason } = req.body;

  const profile = await SellerProfileModel.decideVerification(id, {
    status,
    reason,
    adminId: req.user.id,
  });
  if (profile) {
    const [response] = await toAdminResponses([profile]);
    return res.json({ profile: response });
  }

  if (!(await SellerProfileModel.findById(id))) {
    throw new ApiError(404, "Seller profile not found", { code: "NOT_FOUND" });
  }
  throw new ApiError(409, "Only pending or rejected profiles can be reviewed", {
    code: "INVALID_STATUS_CHANGE",
  });
}

module.exports = { createAdmin, listSellers, decideSeller };
