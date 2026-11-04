// Request body rules for seller endpoints.

const { z } = require("zod");

const url = z.url("Enter a valid URL");
const description = z.string().trim();
const supportEmail = z.string().trim().toLowerCase().max(255).pipe(z.email("Enter a valid email address"));
const supportPhone = z.string().trim().regex(/^\+[1-9][0-9]{6,14}$/, "Phone must be in E.164 format");
const storeName = z.string().trim().min(1, "Store name is required").max(150);
const storeSlug = z
  .string()
  .trim()
  .max(160)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Use lowercase letters, numbers and hyphens, e.g. rk-electronics");
const businessType = z.enum(["individual", "company"]);
const legalBusinessName = z.string().trim().min(1, "Legal business name is required").max(200);
const pickupAddressId = z.uuid("Invalid address id");
// Optional, because sellers without GST registration can list. Checks the format only: 2-digit state
// code, PAN, entity number, Z, check character. It doesn't confirm the GSTIN is real.
const taxId = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, "Enter a valid 15-character GSTIN");

// verification_status, commission_rate and similar fields are set by admins, so they are not accepted here.
const createProfile = z.object({
  storeName,
  storeSlug,
  description: description.optional(),
  logoUrl: url.optional(),
  bannerUrl: url.optional(),
  supportEmail: supportEmail.optional(),
  supportPhone: supportPhone.optional(),
  businessType: businessType.default("individual"),
  legalBusinessName,
  taxId: taxId.optional(),
  pickupAddressId: pickupAddressId.optional(),
});

// Every field is optional, and sending null clears a field the database allows to be empty.
const updateProfile = z
  .object({
    storeName: storeName.optional(),
    storeSlug: storeSlug.optional(),
    description: description.nullable().optional(),
    logoUrl: url.nullable().optional(),
    bannerUrl: url.nullable().optional(),
    supportEmail: supportEmail.nullable().optional(),
    supportPhone: supportPhone.nullable().optional(),
    businessType: businessType.optional(),
    legalBusinessName: legalBusinessName.optional(),
    taxId: taxId.nullable().optional(),
    pickupAddressId: pickupAddressId.nullable().optional(),
  })
  .refine((fields) => Object.keys(fields).length > 0, "Send at least one field to update");

module.exports = { createProfile, updateProfile };
