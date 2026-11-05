// Request rules for the cart. Schemas are strict, so a field customers can't set, such as `price`,
// gets a clear error instead of being ignored.

const { z } = require("zod");

const quantity = z.number().int().min(1).max(10);

const addItem = z.strictObject({ variantId: z.uuid("Invalid id"), quantity: quantity.default(1) });

const changeItem = z.strictObject({ quantity });

// A quantity over the limit is lowered rather than refused, so only an absurd one is a 400.
const mergeCart = z.strictObject({
  items: z
    .array(z.strictObject({ variantId: z.uuid("Invalid id"), quantity: z.number().int().min(1).max(1000000) }))
    .max(50, "At most 50 items"),
});

const variantParam = z.object({ variantId: z.uuid("Invalid id") });

module.exports = { addItem, changeItem, mergeCart, variantParam };
