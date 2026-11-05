// Public product browsing: the product list and one product's page.
//
// Responses are built field by field, so seller-only data (exact stock, SKUs, GSTIN, commission)
// can't reach customers by accident when a column is added.

const BrowseModel = require("../models/browse.model");
const CategoryModel = require("../models/category.model");
const ApiError = require("../utils/ApiError");

function toListItem(row) {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    category: { id: row.category_id, name: row.category_name, slug: row.category_slug },
    brand: row.brand_id ? { id: row.brand_id, name: row.brand_name, slug: row.brand_slug } : null,
    store: { name: row.store_name, slug: row.store_slug },
    price: row.selling_price,
    mrp: row.mrp,
    discountPercent: row.discount_percent,
    image: { url: row.image_url, altText: row.image_alt_text },
    inStock: row.in_stock,
  };
}

function toVariant(variant) {
  return {
    id: variant.id,
    options: variant.options,
    price: variant.selling_price,
    mrp: variant.mrp,
    discountPercent: variant.discount_percent,
    netQuantity: variant.net_quantity,
    inStock: variant.stock_quantity > 0,
  };
}

function toImage(image) {
  return { id: image.id, variantId: image.variant_id, url: image.url, altText: image.alt_text, isPrimary: image.is_primary };
}

// What a product page offers for choosing a variant: only options and values its variants on sale
// use, with readable labels. Sellers' custom values carry their own label on the variant.
async function buildOptionChoices(categoryId, variants) {
  const used = new Map();
  for (const variant of variants) {
    for (const [optionCode, valueCode] of Object.entries(variant.options)) {
      if (!used.has(optionCode)) used.set(optionCode, new Map());
      if (!used.get(optionCode).has(valueCode)) used.get(optionCode).set(valueCode, variant.option_labels[optionCode]);
    }
  }
  if (used.size === 0) return [];

  const [labels, effective] = await Promise.all([
    BrowseModel.findOptionLabels([...used.keys()]),
    CategoryModel.getEffectiveOptions(categoryId),
  ]);
  const position = new Map(effective.map((option, index) => [option.code, index]));

  return [...used.entries()]
    .map(([optionCode, values]) => {
      const known = labels.filter((row) => row.option_code === optionCode);
      const choices = [...values.entries()].map(([valueCode, customLabel]) => {
        const row = known.find((candidate) => candidate.value_code === valueCode);
        return {
          code: valueCode,
          label: row?.label ?? customLabel ?? valueCode,
          colorHex: row?.color_hex ?? null,
          sortOrder: row?.sort_order ?? Number.MAX_SAFE_INTEGER,
        };
      });
      choices.sort((a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label));
      return {
        code: optionCode,
        name: known[0]?.option_name ?? optionCode,
        values: choices.map(({ sortOrder, ...choice }) => choice),
      };
    })
    .sort((a, b) => (position.get(a.code) ?? Infinity) - (position.get(b.code) ?? Infinity));
}

// GET /api/products
async function list(req, res) {
  const { page, limit } = req.query;
  const { rows, total } = await BrowseModel.list(req.query);
  res.json({ products: rows.map(toListItem), pagination: { page, limit, total } });
}

// GET /api/products/:slug: the same 404 for a hidden product as for one that doesn't exist.
async function getOne(req, res) {
  const product = await BrowseModel.findBySlug(req.params.slug);
  if (!product) throw new ApiError(404, "Product not found", { code: "NOT_FOUND" });

  const [variants, images] = await Promise.all([BrowseModel.listVariants(product.id), BrowseModel.listImages(product.id)]);
  const options = await buildOptionChoices(product.category_id, variants);

  res.json({
    product: {
      id: product.id,
      slug: product.slug,
      title: product.title,
      description: product.description,
      highlights: product.highlights,
      specifications: product.specifications,
      category: { id: product.category_id, name: product.category_name, slug: product.category_slug },
      brand: product.brand_id
        ? { id: product.brand_id, name: product.brand_name, slug: product.brand_slug, logoUrl: product.brand_logo_url }
        : null,
      inStock: variants.some((variant) => variant.stock_quantity > 0),
      options,
      variants: variants.map(toVariant),
      images: images.map(toImage),
      legal: {
        genericName: product.generic_name,
        countryOfOrigin: product.country_of_origin,
        manufacturerName: product.manufacturer_name,
        manufacturerAddress: product.manufacturer_address,
        packerDetails: product.packer_details,
        importerDetails: product.importer_details,
      },
      returns: { isReturnable: product.is_returnable, windowDays: product.is_returnable ? product.return_window_days : null },
      warrantySummary: product.warranty_summary,
      seller: {
        storeName: product.store_name,
        storeSlug: product.store_slug,
        logoUrl: product.store_logo_url,
        legalBusinessName: product.legal_business_name,
        supportEmail: product.support_email,
        supportPhone: product.support_phone,
      },
    },
  });
}

module.exports = { list, getOne };
