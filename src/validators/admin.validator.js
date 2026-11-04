// Request rules for the admin seller-review endpoints.

const { z } = require("zod");

const sellerIdParam = z.object({ id: z.uuid("Invalid seller profile id") });

const listSellers = z.object({
  status: z.enum(["pending", "approved", "rejected", "suspended"]).default("pending"),
});

// A rejection must include a reason; an approval has none.
const sellerDecision = z.discriminatedUnion("status", [
  z.object({ status: z.literal("approved") }),
  z.object({
    status: z.literal("rejected"),
    reason: z.string().trim().min(1, "A reason is required when rejecting").max(1000),
  }),
]);

module.exports = { sellerIdParam, listSellers, sellerDecision };
