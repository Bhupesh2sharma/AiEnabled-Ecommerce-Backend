// SQL for product images. Each row records which provider holds the file and where.

const db = require("../config/db");
const buildAssignments = require("../utils/sqlUpdate");

const COLUMNS = { variantId: "variant_id", altText: "alt_text", sortOrder: "sort_order", isPrimary: "is_primary" };

function toSellerImage(image) {
  return {
    id: image.id,
    productId: image.product_id,
    variantId: image.variant_id,
    url: image.url,
    altText: image.alt_text,
    sortOrder: image.sort_order,
    isPrimary: image.is_primary,
    createdAt: image.created_at,
  };
}

async function listForProduct(productId, client = db) {
  const { rows } = await client.query(
    "SELECT * FROM product_images WHERE product_id = $1 ORDER BY is_primary DESC, sort_order, created_at",
    [productId]
  );
  return rows;
}

async function countForProduct(productId, client) {
  const { rows } = await client.query("SELECT COUNT(*)::int AS count FROM product_images WHERE product_id = $1", [
    productId,
  ]);
  return rows[0].count;
}

// Only images on the seller's own live products.
async function findOwned(id, sellerId, client = db) {
  const { rows } = await client.query(
    `SELECT i.* FROM product_images i
     JOIN products p ON p.id = i.product_id AND p.seller_id = $2 AND p.deleted_at IS NULL
     WHERE i.id = $1`,
    [id, sellerId]
  );
  return rows[0] ?? null;
}

async function create(fields, client) {
  const { rows } = await client.query(
    `INSERT INTO product_images (product_id, variant_id, storage_provider, storage_key, url, alt_text, sort_order, is_primary)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      fields.productId,
      fields.variantId ?? null,
      fields.provider,
      fields.storageKey,
      fields.url,
      fields.altText ?? null,
      fields.sortOrder,
      fields.isPrimary,
    ]
  );
  return rows[0];
}

async function update(id, fields, client) {
  const { assignments, values } = buildAssignments(fields, COLUMNS);
  const { rows } = await client.query(`UPDATE product_images SET ${assignments} WHERE id = $1 RETURNING *`, [
    id,
    ...values,
  ]);
  return rows[0];
}

// A product can have only one primary image, so the old one must be cleared first.
async function clearPrimary(productId, client) {
  await client.query("UPDATE product_images SET is_primary = FALSE WHERE product_id = $1 AND is_primary", [productId]);
}

async function remove(id, client) {
  await client.query("DELETE FROM product_images WHERE id = $1", [id]);
}

// After the primary image is deleted, the next one in order takes over.
async function promoteNext(productId, client) {
  await client.query(
    `UPDATE product_images SET is_primary = TRUE
     WHERE id = (SELECT id FROM product_images WHERE product_id = $1 ORDER BY sort_order, created_at LIMIT 1)`,
    [productId]
  );
}

module.exports = {
  toSellerImage,
  listForProduct,
  countForProduct,
  findOwned,
  create,
  update,
  clearPrimary,
  remove,
  promoteNext,
};
