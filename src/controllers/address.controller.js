// Saved addresses, for customers' delivery and billing and sellers' pickup.

const db = require("../config/db");
const AddressModel = require("../models/address.model");
const ApiError = require("../utils/ApiError");
const { INDIAN_STATES } = require("../utils/indianStates");

const MAX_ADDRESSES = 20;

const notFound = () => new ApiError(404, "Address not found", { code: "NOT_FOUND" });

// Users send only the code, so the stored name can't disagree with it.
function withStateName(fields) {
  if (fields.stateCode === undefined) return fields;
  return { ...fields, state: INDIAN_STATES.find((state) => state.code === fields.stateCode).name };
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
    await AddressModel.lockUser(req.user.id, client);

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
    await AddressModel.lockUser(req.user.id, client);
    if (!(await AddressModel.findOwned(req.params.id, req.user.id, client))) throw notFound();

    if (req.body.isDefaultShipping) await AddressModel.clearDefault(req.user.id, "shipping", client);
    if (req.body.isDefaultBilling) await AddressModel.clearDefault(req.user.id, "billing", client);

    return AddressModel.update(req.params.id, withStateName(req.body), client);
  });

  res.json({ address: AddressModel.toAddress(address) });
}

// DELETE /api/addresses/:id: permanent. Orders will keep their own copy of the address.
async function remove(req, res) {
  await db.transaction(async (client) => {
    await AddressModel.lockUser(req.user.id, client);
    const address = await AddressModel.findOwned(req.params.id, req.user.id, client);
    if (!address) throw notFound();

    await AddressModel.remove(address.id, client);
    if (address.is_default_shipping) await AddressModel.promoteNewest(req.user.id, "shipping", client);
    if (address.is_default_billing) await AddressModel.promoteNewest(req.user.id, "billing", client);
  });

  res.status(204).end();
}

module.exports = { listStates, list, getOne, create, update, remove };
