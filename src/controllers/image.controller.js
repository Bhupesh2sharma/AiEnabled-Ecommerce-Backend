// Image uploads. The browser uploads straight to storage with a presigned URL, so large files
// never pass through this server. The backend then checks the file before attaching it.

const crypto = require("crypto");
const db = require("../config/db");
const ProductImageModel = require("../models/productImage.model");
const ProductModel = require("../models/product.model");
const ProductVariantModel = require("../models/productVariant.model");
const storage = require("../services/storage");
const ApiError = require("../utils/ApiError");
const { IMAGE_TYPES, MAX_IMAGE_BYTES, checkImage } = require("../utils/imageFile");

const MAX_IMAGES_PER_PRODUCT = 8;

const productNotFound = () => new ApiError(404, "Product not found", { code: "NOT_FOUND" });
const imageNotFound = () => new ApiError(404, "Image not found", { code: "NOT_FOUND" });

async function createUpload(folder, contentType) {
  const driver = storage.active();
  const storageKey = `${folder}/${crypto.randomUUID()}.${IMAGE_TYPES[contentType].extension}`;
  return {
    uploadUrl: await driver.createUploadUrl(storageKey, contentType),
    method: "PUT",
    headers: { "Content-Type": contentType },
    storageKey,
    publicUrl: driver.publicUrlFor(storageKey),
    expiresInSeconds: driver.uploadUrlSeconds,
    maxSizeBytes: MAX_IMAGE_BYTES,
  };
}

// POST /api/seller/uploads/signature: permission to upload one image to this seller's folder.
async function createSellerUpload(req, res) {
  const upload = await createUpload(`products/${req.sellerProfile.id}`, req.body.contentType);
  res.status(201).json({ upload });
}

// POST /api/admin/uploads/signature: for category images and brand logos. Save `publicUrl` on the category or brand.
async function createAdminUpload(req, res) {
  const folder = req.body.purpose === "category" ? "categories" : "brands";
  const upload = await createUpload(folder, req.body.contentType);
  res.status(201).json({ upload });
}

// Deleting is tidying up, so a failure is logged rather than failing the seller's request.
async function removeFileQuietly(driver, key) {
  if (!driver) {
    console.error(`Can't delete ${key}: its storage provider isn't configured`);
    return;
  }
  try {
    await driver.remove(key);
  } catch (err) {
    console.error(`Failed to delete ${key}:`, err);
  }
}

// Confirms the key is in this seller's folder and the uploaded file really is an acceptable image.
async function assertValidUpload(driver, storageKey, sellerId) {
  if (!storageKey.startsWith(`products/${sellerId}/`)) {
    throw new ApiError(400, "This upload doesn't belong to your store", { code: "INVALID_UPLOAD" });
  }

  const file = await driver.inspect(storageKey);
  if (!file) {
    throw new ApiError(400, "No uploaded file was found. Upload it first", { code: "UPLOAD_NOT_FOUND" });
  }

  const problem = checkImage(file);
  if (problem) {
    await removeFileQuietly(driver, storageKey);
    throw new ApiError(400, problem, { code: "INVALID_UPLOAD" });
  }
}

async function assertVariantOnProduct(variantId, product, client) {
  if (!variantId) return;
  const variant = await ProductVariantModel.findOwned(variantId, product.seller_id, client);
  if (!variant || variant.product_id !== product.id) {
    throw new ApiError(400, "This variant isn't on this product", { code: "INVALID_VARIANT" });
  }
}

// POST /api/seller/products/:id/images: attaches an uploaded file. The first image becomes primary.
async function attachImage(req, res) {
  const sellerId = req.sellerProfile.id;
  const { storageKey, variantId, altText, isPrimary } = req.body;

  if (!(await ProductModel.findOwned(req.params.id, sellerId))) throw productNotFound();

  const driver = storage.active();
  await assertValidUpload(driver, storageKey, sellerId);

  const image = await db.transaction(async (client) => {
    const product = await ProductModel.lockOwned(req.params.id, sellerId, client);
    if (!product) throw productNotFound();
    await assertVariantOnProduct(variantId, product, client);

    const count = await ProductImageModel.countForProduct(product.id, client);
    if (count >= MAX_IMAGES_PER_PRODUCT) {
      throw new ApiError(400, `A product can have at most ${MAX_IMAGES_PER_PRODUCT} images`, {
        code: "IMAGE_LIMIT_REACHED",
      });
    }

    const makePrimary = count === 0 || isPrimary === true;
    if (makePrimary) await ProductImageModel.clearPrimary(product.id, client);

    return ProductImageModel.create(
      {
        productId: product.id,
        variantId,
        provider: driver.provider,
        storageKey,
        url: driver.publicUrlFor(storageKey),
        altText,
        sortOrder: count,
        isPrimary: makePrimary,
      },
      client
    );
  });

  res.status(201).json({ image: ProductImageModel.toSellerImage(image) });
}

// PATCH /api/seller/images/:id: edit text, order or variant, or make this the primary image.
async function updateImage(req, res) {
  const sellerId = req.sellerProfile.id;
  const found = await ProductImageModel.findOwned(req.params.id, sellerId);
  if (!found) throw imageNotFound();

  const image = await db.transaction(async (client) => {
    const product = await ProductModel.lockOwned(found.product_id, sellerId, client);
    const current = await ProductImageModel.findOwned(req.params.id, sellerId, client);
    if (!product || !current) throw imageNotFound();

    await assertVariantOnProduct(req.body.variantId, product, client);
    if (req.body.isPrimary) await ProductImageModel.clearPrimary(product.id, client);
    return ProductImageModel.update(current.id, req.body, client);
  });

  res.json({ image: ProductImageModel.toSellerImage(image) });
}

// DELETE /api/seller/images/:id: a published product must keep at least one image.
async function deleteImage(req, res) {
  const sellerId = req.sellerProfile.id;
  const found = await ProductImageModel.findOwned(req.params.id, sellerId);
  if (!found) throw imageNotFound();

  const removed = await db.transaction(async (client) => {
    const product = await ProductModel.lockOwned(found.product_id, sellerId, client);
    const current = await ProductImageModel.findOwned(req.params.id, sellerId, client);
    if (!product || !current) throw imageNotFound();

    const count = await ProductImageModel.countForProduct(product.id, client);
    if (product.status !== "draft" && count === 1) {
      throw new ApiError(409, "A published product needs an image. Pause or delete the product instead", {
        code: "LAST_IMAGE",
      });
    }

    await ProductImageModel.remove(current.id, client);
    if (current.is_primary) await ProductImageModel.promoteNext(product.id, client);
    return current;
  });

  // Uses the provider recorded on the image, which may not be the current one.
  await removeFileQuietly(storage.drivers[removed.storage_provider], removed.storage_key);
  res.status(204).end();
}

module.exports = { createSellerUpload, createAdminUpload, attachImage, updateImage, deleteImage };
