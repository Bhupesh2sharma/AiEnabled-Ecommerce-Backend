// Request rules for sellers' products and variants. Schemas are strict, so a field sellers can't
// set, such as `status` or `stockQuantity`, gets a clear error instead of being ignored.

const { z } = require("zod");
const { GST_RATES } = require("../utils/gst");
const { IMAGE_TYPES, MAX_IMAGE_BYTES } = require("../utils/imageFile");

const uuid = z.uuid("Invalid id");
const text = (max) => z.string().trim().min(1, "Can't be blank").max(max);
const atLeastOneField = (fields) => Object.keys(fields).length > 0;
const NOTHING_TO_UPDATE = "Send at least one field to update";

// Rupees, up to 2 decimals. Kept as a string, because floating-point numbers can't hold money exactly.
const money = z
  .union([z.number(), z.string().trim()])
  .transform(String)
  .pipe(z.string().regex(/^[0-9]{1,10}(\.[0-9]{1,2})?$/, "Enter an amount such as 499 or 499.50"))
  .refine((value) => Number(value) > 0, "Must be above 0");

const positiveInt = z.number().int().positive().max(100000000);
const gstRate = z
  .number()
  .refine((value) => GST_RATES.includes(value), `GST rate must be one of: ${GST_RATES.join(", ")}`);

const hsnCode = z.string().trim().regex(/^[0-9]{4}([0-9]{2}){0,2}$/, "HSN code must be 4, 6 or 8 digits");
const countryCode = z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, "Use a 2-letter country code, e.g. IN");
const barcode = z.string().trim().regex(/^[0-9]{8,14}$/, "Barcode must be 8 to 14 digits");

const highlights = z.array(text(200)).max(10, "At most 10 highlights");
const specifications = z
  .record(text(100), z.string().trim().max(500))
  .refine((value) => Object.keys(value).length <= 50, "At most 50 specifications");
const options = z.record(z.string().max(50), text(50));

const productFields = {
  brandName: text(100).nullable().optional(),
  description: z.string().trim().nullable().optional(),
  highlights: highlights.optional(),
  specifications: specifications.optional(),
  hsnCode: hsnCode.nullable().optional(),
  genericName: text(150).nullable().optional(),
  countryOfOrigin: countryCode.nullable().optional(),
  manufacturerName: text(200).nullable().optional(),
  manufacturerAddress: text(2000).nullable().optional(),
  packerDetails: text(2000).nullable().optional(),
  importerDetails: text(2000).nullable().optional(),
  isReturnable: z.boolean().optional(),
  returnWindowDays: z.number().int().min(1).max(365).nullable().optional(),
  warrantySummary: text(255).nullable().optional(),
};

const createProduct = z.strictObject({ categoryId: uuid, title: text(200), ...productFields });
const updateProduct = z
  .strictObject({ categoryId: uuid.optional(), title: text(200).optional(), ...productFields })
  .refine(atLeastOneField, NOTHING_TO_UPDATE);

const variantFields = {
  netQuantity: text(50).nullable().optional(),
  weightGrams: positiveInt.nullable().optional(),
  lengthMm: positiveInt.nullable().optional(),
  widthMm: positiveInt.nullable().optional(),
  heightMm: positiveInt.nullable().optional(),
  lowStockThreshold: z.number().int().min(0).max(100000000).optional(),
  barcode: barcode.nullable().optional(),
  isActive: z.boolean().optional(),
};

const createVariant = z.strictObject({
  sku: text(64),
  options: options.default({}),
  mrp: money,
  sellingPrice: money,
  gstRate: gstRate.optional(),
  ...variantFields,
});
const updateVariant = z
  .strictObject({
    sku: text(64).optional(),
    options: options.optional(),
    mrp: money.optional(),
    sellingPrice: money.optional(),
    gstRate: gstRate.optional(),
    ...variantFields,
  })
  .refine(atLeastOneField, NOTHING_TO_UPDATE);

// Orders and returns add their own reasons later, and sellers won't be able to send those.
const changeStock = z
  .strictObject({
    change: z.number().int().min(-10000000).max(10000000).refine((value) => value !== 0, "Change can't be 0"),
    reason: z.enum(["initial", "restock", "correction"]),
    note: text(255).optional(),
  })
  .refine((body) => body.reason === "correction" || body.change > 0, {
    path: ["change"],
    message: "Only a correction can remove stock",
  });

const paging = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const contentType = z.enum(Object.keys(IMAGE_TYPES), { error: "Only JPEG, PNG and WebP images are allowed" });
const sizeBytes = z.number().int().positive().max(MAX_IMAGE_BYTES, "Images must be 5 MB or smaller");

const createUpload = z.strictObject({ contentType, sizeBytes });
const createAdminUpload = z.strictObject({ contentType, sizeBytes, purpose: z.enum(["category", "brand"]) });

const attachImage = z.strictObject({
  storageKey: z.string().max(255),
  variantId: uuid.nullable().optional(),
  altText: text(200).nullable().optional(),
  isPrimary: z.boolean().optional(),
});

// isPrimary can only be turned on: making another image primary is what turns this one off.
const updateImage = z
  .strictObject({
    variantId: uuid.nullable().optional(),
    altText: text(200).nullable().optional(),
    sortOrder: z.number().int().min(0).max(1000).optional(),
    isPrimary: z.literal(true).optional(),
  })
  .refine(atLeastOneField, NOTHING_TO_UPDATE);

const idParam = z.object({ id: uuid });
const listProducts = z.object({
  status: z.enum(["draft", "active", "paused"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

module.exports = {
  createProduct,
  updateProduct,
  createVariant,
  updateVariant,
  changeStock,
  createUpload,
  createAdminUpload,
  attachImage,
  updateImage,
  paging,
  idParam,
  listProducts,
};
