// Admins reviewing and moderating products. admin.routes.js requires an admin login for everything here.
//
// Blocking leaves `status` alone, so unblocking returns a product to where it was: a live product
// goes straight back on sale, and a draft stays a draft.

const AdminProductModel = require("../models/adminProduct.model");
const ProductImageModel = require("../models/productImage.model");
const ProductVariantModel = require("../models/productVariant.model");
const ApiError = require("../utils/ApiError");

const notFound = () => new ApiError(404, "Product not found", { code: "NOT_FOUND" });

// GET /api/admin/products
async function list(req, res) {
  const { page, limit } = req.query;
  const { rows, total } = await AdminProductModel.list(req.query);
  res.json({
    products: rows.map((row) => ({
      ...AdminProductModel.toAdminProduct(row),
      variantCount: row.variant_count,
      primaryImageUrl: row.primary_image_url,
    })),
    pagination: { page, limit, total },
  });
}

// GET /api/admin/products/:id: what's needed to judge a product, including when customers can't see it.
async function getOne(req, res) {
  const product = await AdminProductModel.findById(req.params.id);
  if (!product) throw notFound();
  const [variants, images] = await Promise.all([
    ProductVariantModel.listForProduct(product.id),
    ProductImageModel.listForProduct(product.id),
  ]);
  res.json({
    product: {
      ...AdminProductModel.toAdminProduct(product),
      variants: variants.map(ProductVariantModel.toSellerVariant),
      images: images.map(ProductImageModel.toSellerImage),
    },
  });
}

// Tells apart "doesn't exist" and "already in that state" after a change that did nothing.
async function respondAfterChange(id, changed, res, alreadyMessage) {
  const product = await AdminProductModel.findById(id);
  if (!product) throw notFound();
  if (!changed) throw new ApiError(409, alreadyMessage, { code: "INVALID_STATUS_CHANGE" });
  res.json({ product: AdminProductModel.toAdminProduct(product) });
}

// POST /api/admin/products/:id/block
async function block(req, res) {
  const changed = await AdminProductModel.block(req.params.id, req.user.id, req.body.reason);
  await respondAfterChange(req.params.id, changed, res, "This product is already blocked");
}

// POST /api/admin/products/:id/unblock
async function unblock(req, res) {
  const changed = await AdminProductModel.unblock(req.params.id);
  await respondAfterChange(req.params.id, changed, res, "This product isn't blocked");
}

module.exports = { list, getOne, block, unblock };
