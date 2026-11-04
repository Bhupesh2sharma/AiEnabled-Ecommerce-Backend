const SellerProfileModel = require("../models/sellerProfile.model");
const ApiError = require("../utils/ApiError");

async function createProfile(req, res) {
  const { pickupAddressId } = req.body;
  if (pickupAddressId && !(await SellerProfileModel.userOwnsAddress(req.user.id, pickupAddressId))) {
    throw new ApiError(400, "Pickup address not found", { code: "INVALID_PICKUP_ADDRESS" });
  }

  const profile = await SellerProfileModel.create(req.user.id, req.body);
  res.status(201).json({ profile: SellerProfileModel.toPublicProfile(profile) });
}

module.exports = { createProfile };
