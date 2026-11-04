// Sellers' products and variants. Other sellers' records return 404, so they can't be discovered.

const crypto = require("crypto");
const db = require("../config/db");
const BrandModel = require("../models/brand.model");
const CategoryModel = require("../models/category.model");
const ProductModel = require("../models/product.model");
const ProductVariantModel = require("../models/productVariant.model");
const ApiError = require("../utils/ApiError");
const slugify = require("../utils/slug");
const normalizeOptions = require("../utils/variantOptions");

const MAX_VARIANTS_PER_PRODUCT = 100;

// Non-draft products must keep these (the database also enforces this).
const LEGAL_FIELDS = [
  ["genericName", "generic_name"],
  ["countryOfOrigin", "country_of_origin"],
  ["manufacturerName", "manufacturer_name"],
  ["manufacturerAddress", "manufacturer_address"],
];

const productNotFound = () => new ApiError(404, "Product not found", { code: "NOT_FOUND" });
const variantNotFound = () => new ApiError(404, "Variant not found", { code: "NOT_FOUND" });

const withVariants = (product, variants) => ({
  ...ProductModel.toSellerProduct(product),
  variants: variants.map(ProductVariantModel.toSellerVariant),
});

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

  res.status(201).json({ product: withVariants(product, []) });
}

// GET /api/seller/products: my products in any status, newest first.
async function listProducts(req, res) {
  const { page, limit } = req.query;
  const { rows, total } = await ProductModel.listOwned(req.sellerProfile.id, req.query);
  res.json({
    products: rows.map((row) => ({ ...ProductModel.toSellerProduct(row), variantCount: row.variant_count })),
    pagination: { page, limit, total },
  });
}

// GET /api/seller/products/:id
async function getProduct(req, res) {
  const product = await ProductModel.findOwned(req.params.id, req.sellerProfile.id);
  if (!product) throw productNotFound();
  const variants = await ProductVariantModel.listForProduct(product.id);
  res.json({ product: withVariants(product, variants) });
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

function assertLegalDetailsKept(product, fields) {
  if (product.status === "draft") return;
  const details = LEGAL_FIELDS.filter(([field]) => fields[field] === null).map(([field]) => ({
    field,
    message: "A published product must keep this detail",
  }));
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

    assertLegalDetailsKept(current, req.body);
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

  const variants = await ProductVariantModel.listForProduct(product.id);
  res.json({ product: withVariants(product, variants) });
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

module.exports = {
  createProduct,
  listProducts,
  getProduct,
  updateProduct,
  deleteProduct,
  createVariant,
  updateVariant,
  deleteVariant,
};
