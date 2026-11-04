// Request body rules for seller endpoints.

const { z } = require("zod");

const optionalUrl = z.url("Enter a valid URL").optional();

// verification_status, commission_rate and similar fields are set by admins, so they are not accepted here.
const createProfile = z.object({
  storeName: z.string().trim().min(1, "Store name is required").max(150),
  storeSlug: z
    .string()
    .trim()
    .max(160)
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Use lowercase letters, numbers and hyphens, e.g. rk-electronics"),
  description: z.string().trim().optional(),
  logoUrl: optionalUrl,
  bannerUrl: optionalUrl,
  supportEmail: z.string().trim().toLowerCase().max(255).pipe(z.email("Enter a valid email address")).optional(),
  supportPhone: z.string().trim().regex(/^\+[1-9][0-9]{6,14}$/, "Phone must be in E.164 format").optional(),
  businessType: z.enum(["individual", "company"]).default("individual"),
  legalBusinessName: z.string().trim().min(1, "Legal business name is required").max(200),
  taxId: z.string().trim().max(50).optional(),
  pickupAddressId: z.uuid("Invalid address id").optional(),
});

module.exports = { createProfile };
