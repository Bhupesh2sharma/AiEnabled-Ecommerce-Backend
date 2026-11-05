// Saved addresses, for customers' delivery and billing and sellers' pickup.

const db = require("../config/db");
const AddressModel = require("../models/address.model");
const SellerProfileModel = require("../models/sellerProfile.model");
const UserModel = require("../models/user.model");
const ApiError = require("../utils/ApiError");
const { assertPickupMatchesGstin } = require("../utils/gst");
const { INDIAN_STATES } = require("../utils/indianStates");

const MAX_ADDRESSES = 20;

const notFound = () => new ApiError(404, "Address not found", { code: "NOT_FOUND" });

// Users send only the code, so the stored name can't disagree with it.
function withStateName(fields) {
  if (fields.stateCode === undefined) return fields;
  return { ...fields, state: INDIAN_STATES.find((state) => state.code === fields.stateCode).name };
}

// A store's pickup address has rules a personal address doesn't. Choosing a default is always fine,
// because it changes nothing about where the store ships from.
function assertPickupEditAllowed(store, body) {
  const { isDefaultShipping, isDefaultBilling, ...details } = body;
  if (store.verification_status === "suspended" && Object.keys(details).length > 0) {
    throw new ApiError(409, "A suspended store can't change its pickup address", { code: "PROFILE_SUSPENDED" });
  }
  if (store.tax_id && body.stateCode !== undefined) assertPickupMatchesGstin(store.tax_id, body.stateCode);
}

// GET /api/states: for the address form's dropdown.
function listStates(req, res) {
  res.json({ states: INDIAN_STATES });
}

// GET /api/addresses: defaults first, then newest.
async function list(req, res) {
  const addresses = await AddressModel.listForUser(req.user.id);
  res.json({ addresses: addresses.map(AddressModel.toAddress) });
}

// GET /api/addresses/:id
async function getOne(req, res) {
  const address = await AddressModel.findOwned(req.params.id, req.user.id);
  if (!address) throw notFound();
  res.json({ address: AddressModel.toAddress(address) });
}

// POST /api/addresses: a user's first address becomes both defaults.
async function create(req, res) {
  const address = await db.transaction(async (client) => {
    await UserModel.lockForChange(req.user.id, client);

    const count = await AddressModel.countForUser(req.user.id, client);
    if (count >= MAX_ADDRESSES) {
      throw new ApiError(409, `You can save at most ${MAX_ADDRESSES} addresses. Delete one first`, {
        code: "ADDRESS_LIMIT_REACHED",
      });
    }

    const isFirst = count === 0;
    const { isDefaultShipping = false, isDefaultBilling = false } = req.body;
    if (isDefaultShipping) await AddressModel.clearDefault(req.user.id, "shipping", client);
    if (isDefaultBilling) await AddressModel.clearDefault(req.user.id, "billing", client);

    return AddressModel.create(
      req.user.id,
      {
        ...withStateName(req.body),
        isDefaultShipping: isFirst || isDefaultShipping,
        isDefaultBilling: isFirst || isDefaultBilling,
      },
      client
    );
  });

  res.status(201).json({ address: AddressModel.toAddress(address) });
}

// PATCH /api/addresses/:id: `null` clears an optional field. A default can only be turned on here:
// choosing another address is what turns it off, so a user with addresses always has one.
async function update(req, res) {
  const address = await db.transaction(async (client) => {
    await UserModel.lockForChange(req.user.id, client);
    if (!(await AddressModel.findOwned(req.params.id, req.user.id, client))) throw notFound();

    const store = await SellerProfileModel.findByPickupAddress(req.params.id, client);
    if (store) assertPickupEditAllowed(store, req.body);

    if (req.body.isDefaultShipping) await AddressModel.clearDefault(req.user.id, "shipping", client);
    if (req.body.isDefaultBilling) await AddressModel.clearDefault(req.user.id, "billing", client);

    return AddressModel.update(req.params.id, withStateName(req.body), client);
  });

  res.json({ address: AddressModel.toAddress(address) });
}

// DELETE /api/addresses/:id: permanent. Orders will keep their own copy of the address.
async function remove(req, res) {
  await db.transaction(async (client) => {
    await UserModel.lockForChange(req.user.id, client);
    const address = await AddressModel.findOwned(req.params.id, req.user.id, client);
    if (!address) throw notFound();

    // Without this check, the database would quietly clear the store's pickup address.
    if (await SellerProfileModel.findByPickupAddress(address.id, client)) {
      throw new ApiError(409, "This is your store's pickup address. Choose another first", { code: "ADDRESS_IN_USE" });
    }

    await AddressModel.remove(address.id, client);
    if (address.is_default_shipping) await AddressModel.promoteNewest(req.user.id, "shipping", client);
    if (address.is_default_billing) await AddressModel.promoteNewest(req.user.id, "billing", client);
  });

  res.status(204).end();
}

module.exports = { listStates, list, getOne, create, update, remove };
