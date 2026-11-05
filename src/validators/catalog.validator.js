// Request rules for categories, brands and variant options.
// Edit schemas are strict, so sending a field that can't change, such as `code`, gets a clear error.

const { z } = require("zod");

const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SLUG_MESSAGE = "Use lowercase letters, numbers and hyphens";

const uuid = z.uuid("Invalid id");
const slug = (max) => z.string().trim().max(max).regex(SLUG_PATTERN, SLUG_MESSAGE);
const name = (max) => z.string().trim().min(1, "Name is required").max(max);
const httpUrl = z.httpUrl("Enter a valid http or https URL");
const sortOrder = z.number().int().min(-1000000).max(1000000);
const hsnCode = z.string().trim().regex(/^[0-9]{4}([0-9]{2}){0,2}$/, "HSN code must be 4, 6 or 8 digits");
const colorHex = z.string().trim().toUpperCase().regex(/^#[0-9A-F]{6}$/, "Use a colour such as #FF0000");
const atLeastOneField = (fields) => Object.keys(fields).length > 0;
const NOTHING_TO_UPDATE = "Send at least one field to update";

const idParam = z.object({ id: uuid });
const valueParams = z.object({ id: uuid, valueId: uuid });

const paging = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
};
// Postgres refuses text containing a NUL character, so it's stopped here instead of becoming a 500.
const searchText = z.string().trim().max(100).regex(/^[^\0]*$/, "Invalid search text");
const brandQuery = z.object({ q: searchText.optional(), ...paging });

// Accepts ?x=a,b and ?x=a&x=b.
const listOf = (item, max) =>
  z.preprocess(
    (value) => (value === undefined ? value : [value].flat().flatMap((entry) => String(entry).split(","))),
    z.array(item).min(1).max(max, `At most ${max} values`).optional()
  );

const price = z.string().trim().regex(/^[0-9]{1,10}(\.[0-9]{1,2})?$/, "Enter an amount such as 499 or 499.50");

// "size:m" becomes { size: ["m"] }. Codes are stored lowercase, hyphenated.
const optionFilter = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*:[a-z0-9]+(-[a-z0-9]+)*$/, "Use option:value, e.g. size:m");
const groupOptions = (pairs) => {
  if (!pairs) return undefined;
  const groups = {};
  for (const pair of pairs) {
    const [code, value] = pair.split(":");
    (groups[code] ??= []).push(value);
  }
  return groups;
};

// The page cap also keeps a huge page number from reaching Postgres as an impossible OFFSET.
const browseProducts = z
  .object({
    q: searchText.transform((value) => value || undefined).optional(), // an empty search box means no search
    categoryId: uuid.optional(),
    brandId: listOf(uuid, 20),
    minPrice: price.optional(),
    maxPrice: price.optional(),
    inStock: z.stringbool().optional(),
    option: listOf(optionFilter, 20).transform(groupOptions),
    sort: z.enum(["relevance", "newest", "price_asc", "price_desc"]).optional(),
    page: z.coerce.number().int().min(1).max(1000).default(1),
    limit: z.coerce.number().int().min(1).max(50).default(24),
  })
  .refine((query) => !query.minPrice || !query.maxPrice || Number(query.minPrice) <= Number(query.maxPrice), {
    path: ["minPrice"],
    message: "minPrice can't be above maxPrice",
  })
  .transform((query) => ({ ...query, sort: query.sort ?? (query.q ? "relevance" : "newest") }));

const productSlugParam = z.object({ slug: slug(220) });

const adminProductQuery = z.object({
  status: z.enum(["draft", "active", "paused"]).optional(),
  blocked: z.stringbool().optional(),
  sellerId: uuid.optional(),
  q: searchText.transform((value) => value || undefined).optional(), // part of a title, or an exact slug
  ...paging,
});

// Sellers see this reason, so it should tell them what to fix.
const blockProduct = z.strictObject({ reason: z.string().trim().min(1, "Give a reason").max(1000) });

const createCategory = z.object({
  name: name(100),
  slug: slug(120).optional(), // made from the name if not sent
  parentId: uuid.nullable().optional(),
  description: z.string().trim().nullable().optional(),
  imageUrl: httpUrl.nullable().optional(),
  defaultHsnCode: hsnCode.nullable().optional(),
  sortOrder: sortOrder.optional(),
  isActive: z.boolean().optional(),
});
const updateCategory = z
  .strictObject({
    name: name(100).optional(),
    slug: slug(120).optional(),
    parentId: uuid.nullable().optional(),
    description: z.string().trim().nullable().optional(),
    imageUrl: httpUrl.nullable().optional(),
    defaultHsnCode: hsnCode.nullable().optional(),
    sortOrder: sortOrder.optional(),
    isActive: z.boolean().optional(),
  })
  .refine(atLeastOneField, NOTHING_TO_UPDATE);

const createBrand = z.object({
  name: name(100),
  slug: slug(120).optional(),
  logoUrl: httpUrl.nullable().optional(),
  isActive: z.boolean().optional(),
});
const updateBrand = z
  .strictObject({
    name: name(100).optional(),
    slug: slug(120).optional(),
    logoUrl: httpUrl.nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .refine(atLeastOneField, NOTHING_TO_UPDATE);

const createOption = z.object({
  name: name(50),
  code: slug(50).optional(), // made from the name if not sent; can't change afterwards
  allowCustomValues: z.boolean().optional(),
});
const updateOption = z
  .strictObject({ name: name(50).optional(), allowCustomValues: z.boolean().optional() })
  .refine(atLeastOneField, NOTHING_TO_UPDATE);

const createValue = z.object({
  label: name(50),
  code: slug(50).optional(), // made from the label if not sent; can't change afterwards
  colorHex: colorHex.nullable().optional(),
  sortOrder: sortOrder.optional(),
});
const updateValue = z
  .strictObject({
    label: name(50).optional(),
    colorHex: colorHex.nullable().optional(),
    sortOrder: sortOrder.optional(),
  })
  .refine(atLeastOneField, NOTHING_TO_UPDATE);

const setCategoryOptions = z.object({
  options: z
    .array(
      z.object({
        optionId: uuid,
        isRequired: z.boolean().default(true),
        sortOrder: sortOrder.default(0),
      })
    )
    .max(10, "A category can use at most 10 options")
    .refine((options) => new Set(options.map((o) => o.optionId)).size === options.length, "Each option can appear once"),
});

module.exports = {
  idParam,
  valueParams,
  brandQuery,
  browseProducts,
  productSlugParam,
  adminProductQuery,
  blockProduct,
  createCategory,
  updateCategory,
  createBrand,
  updateBrand,
  createOption,
  updateOption,
  createValue,
  updateValue,
  setCategoryOptions,
};
