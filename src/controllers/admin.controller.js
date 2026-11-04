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

async function listSellers(req, res) {
  const profiles = await SellerProfileModel.listByStatus(req.query.status);
  res.json({ profiles: profiles.map(SellerProfileModel.toAdminProfile) });
}

async function decideSeller(req, res) {
  const { id } = req.params;
  const { status, reason } = req.body;

  const profile = await SellerProfileModel.decideVerification(id, {
    status,
    reason,
    adminId: req.user.id,
  });
  if (profile) return res.json({ profile: SellerProfileModel.toAdminProfile(profile) });

  if (!(await SellerProfileModel.findById(id))) {
    throw new ApiError(404, "Seller profile not found", { code: "NOT_FOUND" });
  }
  throw new ApiError(409, "Only pending or rejected profiles can be reviewed", {
    code: "INVALID_STATUS_CHANGE",
  });
}

module.exports = { createAdmin, listSellers, decideSeller };
