// Sellers' products and variants. Other sellers' records return 404, so they can't be discovered.

const crypto = require("crypto");
const db = require("../config/db");
const BrandModel = require("../models/brand.model");
const CategoryModel = require("../models/category.model");
const ProductImageModel = require("../models/productImage.model");
const ProductModel = require("../models/product.model");
const ProductVariantModel = require("../models/productVariant.model");
const SellerProfileModel = require("../models/sellerProfile.model");
const ApiError = require("../utils/ApiError");
const slugify = require("../utils/slug");
const normalizeOptions = require("../utils/variantOptions");

const MAX_VARIANTS_PER_PRODUCT = 100;

// Non-draft products must keep these (the database also enforces this).
const LEGAL_FIELDS = [
  ["genericName", "generic_name", "Enter the generic name, such as Men's T-Shirt"],
  ["countryOfOrigin", "country_of_origin", "Enter the country of origin"],
  ["manufacturerName", "manufacturer_name", "Enter the manufacturer's name"],
  ["manufacturerAddress", "manufacturer_address", "Enter the manufacturer's address"],
];

// Every variant on sale needs these. Customers must see net quantity, and couriers charge on the rest.
const VARIANT_PUBLISH_FIELDS = [
  ["netQuantity", "net_quantity", "net quantity"],
  ["weightGrams", "weight_grams", "weight"],
  ["lengthMm", "length_mm", "length"],
  ["widthMm", "width_mm", "width"],
  ["heightMm", "height_mm", "height"],
];

const productNotFound = () => new ApiError(404, "Product not found", { code: "NOT_FOUND" });
const variantNotFound = () => new ApiError(404, "Variant not found", { code: "NOT_FOUND" });

const withDetails = (product, variants, images) => ({
  ...ProductModel.toSellerProduct(product),
  variants: variants.map(ProductVariantModel.toSellerVariant),
  images: images.map(ProductImageModel.toSellerImage),
});

async function loadDetails(product) {
  const [variants, images] = await Promise.all([
    ProductVariantModel.listForProduct(product.id),
    ProductImageModel.listForProduct(product.id),
  ]);
  return withDetails(product, variants, images);
}

// A short random ending keeps URLs unique, because two sellers can use the same title.
function makeSlug(title) {
  const base = slugify(title).slice(0, 200).replace(/-+$/, "") || "product";
  return `${base}-${crypto.randomBytes(4).toString("hex")}`;
}

// Takes the shared tree lock, so an admin can't give this category sub-categories or delete it
// until this transaction ends. Any number of products can hold the lock at once.
async function assertUsableCategory(categoryId, client) {
  await CategoryModel.lockTreeShared(client);

  if (!(await CategoryModel.isVisible(categoryId, client))) {
    throw new ApiError(400, "Category not found or inactive", { code: "INVALID_CATEGORY" });
  }
  if (await CategoryModel.hasChildren(categoryId, client)) {
    throw new ApiError(400, "Choose the most specific category, one with no sub-categories", {
      code: "CATEGORY_NOT_LEAF",
    });
  }
}

// Replaces brandName with the brand's id. An unknown name creates the brand.
async function resolveBrand(fields, client) {
  const { brandName, ...rest } = fields;
  if (brandName === undefined) return rest;
  if (brandName === null) return { ...rest, brandId: null };

  const brand = await BrandModel.findOrCreate(brandName, client);
  if (!brand.is_active) {
    throw new ApiError(400, "This brand isn't available", { code: "BRAND_INACTIVE" });
  }
  return { ...rest, brandId: brand.id };
}

function assertReturnWindow(isReturnable, returnWindowDays) {
  if (isReturnable && returnWindowDays === null) {
    throw new ApiError(400, "Validation failed", {
      code: "VALIDATION_ERROR",
      details: [{ field: "returnWindowDays", message: "A returnable product needs a return window" }],
    });
  }
}

// Sellers with no GSTIN don't charge GST. Sellers with one must state the rate, even if it's 0.
function assertGstRate(profile, rate, { required }) {
  if (!profile.tax_id && rate !== undefined && rate !== 0) {
    throw new ApiError(400, "Without a GSTIN, the GST rate must be 0", { code: "GST_NOT_ALLOWED" });
  }
  if (profile.tax_id && required && rate === undefined) {
    throw new ApiError(400, "Validation failed", {
      code: "VALIDATION_ERROR",
      details: [{ field: "gstRate", message: "Enter the GST rate, because this store has a GSTIN" }],
    });
  }
}

const toPaise = (amount) => {
  const [rupees, paise = ""] = String(amount).split(".");
  return BigInt(rupees) * 100n + BigInt(paise.padEnd(2, "0"));
};

function assertPriceWithinMrp(sellingPrice, mrp) {
  if (toPaise(sellingPrice) > toPaise(mrp)) {
    throw new ApiError(400, "Selling price can't be above MRP", { code: "PRICE_ABOVE_MRP" });
  }
}

// POST /api/seller/products: creates a draft. Variants are added separately.
async function createProduct(req, res) {
  assertReturnWindow(req.body.isReturnable ?? true, req.body.returnWindowDays === null ? null : 7);

  const product = await db.transaction(async (client) => {
    await assertUsableCategory(req.body.categoryId, client);
    const fields = await resolveBrand(req.body, client);
    return ProductModel.create(req.sellerProfile.id, makeSlug(fields.title), fields, client);
  });

  res.status(201).json({ product: withDetails(product, [], []) });
}

// GET /api/seller/products: my products in any status, newest first.
async function listProducts(req, res) {
  const { page, limit } = req.query;
  const { rows, total } = await ProductModel.listOwned(req.sellerProfile.id, req.query);
  res.json({
    products: rows.map((row) => ({
      ...ProductModel.toSellerProduct(row),
      variantCount: row.variant_count,
      primaryImageUrl: row.primary_image_url,
    })),
    pagination: { page, limit, total },
  });
}

// GET /api/seller/products/:id
async function getProduct(req, res) {
  const product = await ProductModel.findOwned(req.params.id, req.sellerProfile.id);
  if (!product) throw productNotFound();
  res.json({ product: await loadDetails(product) });
}

// A product can move category only if its variants still fit the new one.
async function assertVariantsFitCategory(productId, categoryId, client) {
  const allowed = await CategoryModel.getEffectiveOptions(categoryId, client);
  const variants = await ProductVariantModel.listForProduct(productId, client);
  const misfits = [];
  for (const variant of variants) {
    try {
      normalizeOptions(allowed, variant.options);
    } catch {
      misfits.push({ field: "categoryId", message: `Variant ${variant.sku} doesn't fit this category` });
    }
  }
  if (misfits.length > 0) {
    throw new ApiError(409, "Edit or remove variants that don't fit this category first", {
      code: "VARIANTS_DONT_FIT_CATEGORY",
      details: misfits,
    });
  }
}

function assertLegalDetailsKept(product, fields, profile) {
  if (product.status === "draft") return;
  const required = LEGAL_FIELDS.map(([field]) => field);
  if (profile.tax_id) required.push("hsnCode");
  const details = required
    .filter((field) => fields[field] === null)
    .map((field) => ({ field, message: "A published product must keep this detail" }));
  if (details.length > 0) {
    throw new ApiError(400, "A published product must keep its legal details", {
      code: "LEGAL_DETAILS_REQUIRED",
      details,
    });
  }
}

// PATCH /api/seller/products/:id: status, URL and price summary can't be set here.
async function updateProduct(req, res) {
  const product = await db.transaction(async (client) => {
    const current = await ProductModel.lockOwned(req.params.id, req.sellerProfile.id, client);
    if (!current) throw productNotFound();

    assertLegalDetailsKept(current, req.body, req.sellerProfile);
    assertReturnWindow(
      req.body.isReturnable ?? current.is_returnable,
      req.body.returnWindowDays === undefined ? current.return_window_days : req.body.returnWindowDays
    );

    const { categoryId } = req.body;
    if (categoryId && categoryId !== current.category_id) {
      await assertUsableCategory(categoryId, client);
      await assertVariantsFitCategory(current.id, categoryId, client);
    }

    const fields = await resolveBrand(req.body, client);
    if (Object.keys(fields).length === 0) return current;
    return ProductModel.update(current.id, fields, client);
  });

  res.json({ product: await loadDetails(product) });
}

// DELETE /api/seller/products/:id: soft delete, along with its variants.
async function deleteProduct(req, res) {
  await db.transaction(async (client) => {
    const product = await ProductModel.lockOwned(req.params.id, req.sellerProfile.id, client);
    if (!product) throw productNotFound();
    await ProductModel.softDelete(product.id, client);
  });
  res.status(204).end();
}

// What this variant still needs before it can be on sale. `fields` overrides the stored values.
function missingVariantDetails(variant, fields = {}) {
  return VARIANT_PUBLISH_FIELDS.filter(([field, column]) => {
    const value = fields[field] === undefined ? variant[column] : fields[field];
    return value === null || value === undefined;
  });
}

// A published product can't gain, or re-activate, a variant that's missing details.
function assertVariantComplete(product, variant, fields) {
  if (product.status === "draft") return;
  const isActive = fields.isActive ?? variant.is_active ?? true;
  if (!isActive) return;
  const missing = missingVariantDetails(variant, fields);
  if (missing.length > 0) {
    throw new ApiError(400, "A variant on a published product needs all its details", {
      code: "VARIANT_DETAILS_REQUIRED",
      details: missing.map(([field, , label]) => ({ field, message: `Enter the ${label}` })),
    });
  }
}

// POST /api/seller/products/:id/variants
async function createVariant(req, res) {
  assertGstRate(req.sellerProfile, req.body.gstRate, { required: true });
  assertPriceWithinMrp(req.body.sellingPrice, req.body.mrp);

  const variant = await db.transaction(async (client) => {
    const product = await ProductModel.lockOwned(req.params.id, req.sellerProfile.id, client);
    if (!product) throw productNotFound();

    if ((await ProductVariantModel.countForProduct(product.id, client)) >= MAX_VARIANTS_PER_PRODUCT) {
      throw new ApiError(400, `A product can have at most ${MAX_VARIANTS_PER_PRODUCT} variants`, {
        code: "VARIANT_LIMIT_REACHED",
      });
    }

    assertVariantComplete(product, {}, req.body);

    const allowed = await CategoryModel.getEffectiveOptions(product.category_id, client);
    const created = await ProductVariantModel.create(
      product,
      { ...req.body, ...normalizeOptions(allowed, req.body.options) },
      client
    );
    await ProductModel.refreshMinPrice(product.id, client);
    return created;
  });

  res.status(201).json({ variant: ProductVariantModel.toSellerVariant(variant) });
}

// Locks the variant's product first, so all changes to one product run one at a time.
async function withLockedVariant(req, client) {
  const found = await ProductVariantModel.findOwned(req.params.id, req.sellerProfile.id, client);
  if (!found) throw variantNotFound();

  const product = await ProductModel.lockOwned(found.product_id, req.sellerProfile.id, client);
  const variant = await ProductVariantModel.findOwned(req.params.id, req.sellerProfile.id, client);
  if (!product || !variant) throw variantNotFound();
  return { product, variant };
}

// PATCH /api/seller/variants/:id: stock has its own endpoint, so it can't be set here.
async function updateVariant(req, res) {
  assertGstRate(req.sellerProfile, req.body.gstRate, { required: false });

  const updated = await db.transaction(async (client) => {
    const { product, variant } = await withLockedVariant(req, client);

    assertPriceWithinMrp(req.body.sellingPrice ?? variant.selling_price, req.body.mrp ?? variant.mrp);
    assertVariantComplete(product, variant, req.body);

    const fields = { ...req.body };
    if (req.body.options) {
      const allowed = await CategoryModel.getEffectiveOptions(product.category_id, client);
      Object.assign(
        fields,
        normalizeOptions(allowed, req.body.options, {
          options: variant.options,
          optionLabels: variant.option_labels,
        })
      );
    }

    const result = await ProductVariantModel.update(variant.id, fields, client);
    await ProductModel.refreshMinPrice(product.id, client);
    return result;
  });

  res.json({ variant: ProductVariantModel.toSellerVariant(updated) });
}

// DELETE /api/seller/variants/:id: a published product must keep at least one variant.
async function deleteVariant(req, res) {
  await db.transaction(async (client) => {
    const { product, variant } = await withLockedVariant(req, client);

    if (product.status !== "draft" && (await ProductVariantModel.countForProduct(product.id, client)) === 1) {
      throw new ApiError(409, "A published product needs a variant. Pause or delete the product instead", {
        code: "LAST_VARIANT",
      });
    }

    await ProductVariantModel.softDelete(variant.id, client);
    await ProductModel.refreshMinPrice(product.id, client);
  });

  res.status(204).end();
}

// Everything stopping a product going live, so a seller can fix it all at once rather than one error at a time.
async function findPublishProblems(product, profile, client) {
  const problems = [];
  const add = (field, message) => problems.push({ field, message });

  for (const [field, column, message] of LEGAL_FIELDS) {
    if (!product[column]) add(field, message);
  }
  if (profile.tax_id && !product.hsn_code) add("hsnCode", "Enter the HSN code, because this store has a GSTIN");

  await CategoryModel.lockTreeShared(client);
  if (!(await CategoryModel.isVisible(product.category_id, client))) {
    add("categoryId", "This category is no longer available. Choose another");
  } else if (await CategoryModel.hasChildren(product.category_id, client)) {
    add("categoryId", "This category now has sub-categories. Choose one of them");
  }

  const variants = await ProductVariantModel.listForProduct(product.id, client);
  const onSale = variants.filter((variant) => variant.is_active);
  if (onSale.length === 0) add("variants", "Add at least one active variant");
  for (const variant of onSale) {
    for (const [field, , label] of missingVariantDetails(variant)) {
      add(`variants.${variant.sku}.${field}`, `Enter the ${label} for ${variant.sku}`);
    }
    if (!profile.tax_id && Number(variant.gst_rate) !== 0) {
      add(`variants.${variant.sku}.gstRate`, `Without a GSTIN, the GST rate for ${variant.sku} must be 0`);
    }
  }

  if ((await ProductImageModel.countForProduct(product.id, client)) === 0) add("images", "Add at least one image");

  return problems;
}

// POST /api/seller/products/:id/publish: puts a draft or paused product on sale.
async function publishProduct(req, res) {
  const product = await db.transaction(async (client) => {
    // Locked first, matching the profile edit, so a GSTIN change can't slip past these checks.
    const profile = await SellerProfileModel.findByUserIdForShare(req.user.id, client);
    if (profile?.verification_status !== "approved") {
      throw new ApiError(403, "Your store must be approved before you can publish", { code: "SELLER_NOT_APPROVED" });
    }

    const current = await ProductModel.lockOwned(req.params.id, profile.id, client);
    if (!current) throw productNotFound();

    if (current.blocked_at) {
      throw new ApiError(403, `An admin has blocked this product: ${current.blocked_reason}`, {
        code: "PRODUCT_BLOCKED",
      });
    }

    const problems = await findPublishProblems(current, profile, client);
    if (problems.length > 0) {
      throw new ApiError(400, "This product isn't ready to publish", { code: "PRODUCT_NOT_READY", details: problems });
    }

    return ProductModel.setStatus(current.id, "active", client);
  });

  res.json({ product: await loadDetails(product) });
}

// POST /api/seller/products/:id/pause: takes a product off sale, keeping everything. Publishing brings it back.
async function pauseProduct(req, res) {
  const product = await db.transaction(async (client) => {
    const current = await ProductModel.lockOwned(req.params.id, req.sellerProfile.id, client);
    if (!current) throw productNotFound();
    if (current.status === "draft") {
      throw new ApiError(409, "This product is a draft, so it isn't on sale", { code: "INVALID_STATUS_CHANGE" });
    }
    return ProductModel.setStatus(current.id, "paused", client);
  });

  res.json({ product: await loadDetails(product) });
}

module.exports = {
  publishProduct,
  pauseProduct,
  createProduct,
  listProducts,
  getProduct,
  updateProduct,
  deleteProduct,
  createVariant,
  updateVariant,
  deleteVariant,
};
