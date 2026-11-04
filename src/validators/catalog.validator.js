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
const brandQuery = z.object({ q: z.string().trim().max(100).optional(), ...paging });

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
