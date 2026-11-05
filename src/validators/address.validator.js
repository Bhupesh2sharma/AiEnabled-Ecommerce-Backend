// Request rules for addresses. Schemas are strict, so a field users can't set, such as `state` or
// `countryCode`, gets a clear error instead of being ignored.

const { z } = require("zod");
const { INDIAN_STATES } = require("../utils/indianStates");

const text = (max) => z.string().trim().min(1, "Can't be blank").max(max);

const phone = z.string().trim().regex(/^\+91[6-9][0-9]{9}$/, "Enter an Indian mobile number, e.g. +919876543210");
const stateCode = z.enum(
  INDIAN_STATES.map((state) => state.code),
  { error: "Choose a state from GET /api/states" }
);
const postalCode = z.string().trim().regex(/^[1-9][0-9]{5}$/, "PIN code must be 6 digits and can't start with 0");

// Only `true`: choosing another address is what turns a default off.
const makeDefault = z.literal(true, { error: "Send true, or leave this out" }).optional();

const required = { fullName: text(100), phone, addressLine1: text(255), city: text(100), stateCode, postalCode };
const optional = {
  label: text(50).nullable().optional(),
  addressLine2: text(255).nullable().optional(),
  landmark: text(255).nullable().optional(),
  isDefaultShipping: makeDefault,
  isDefaultBilling: makeDefault,
};

const createAddress = z.strictObject({ ...required, ...optional });

const updateAddress = z
  .strictObject({
    ...Object.fromEntries(Object.entries(required).map(([field, schema]) => [field, schema.optional()])),
    ...optional,
  })
  .refine((fields) => Object.keys(fields).length > 0, "Send at least one field to update");

const idParam = z.object({ id: z.uuid("Invalid id") });

module.exports = { createAddress, updateAddress, idParam };
