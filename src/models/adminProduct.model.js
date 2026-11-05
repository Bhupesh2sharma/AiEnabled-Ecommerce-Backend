// SQL for admins reviewing products. Unlike product.model.js, these reach every seller's products,
// whatever their status. Soft-deleted products stay out: they're gone for everyone but the database.

const db = require("../config/db");
const ProductModel = require("./product.model");

const WITH_STORE = `
  FROM products p
  JOIN seller_profiles s ON s.id = p.seller_id`;

const STORE_COLUMNS = `s.store_name, s.store_slug, s.verification_status AS seller_status`;

function toAdminProduct(row) {
  return {
    ...ProductModel.toSellerProduct(row),
    sellerId: row.seller_id,
    store: { name: row.store_name, slug: row.store_slug, verificationStatus: row.seller_status },
    blockedAt: row.blocked_at,
    blockedBy: row.blocked_by,
  };
}

// So a "%" or "_" in the search is looked for, rather than treated as a wildcard.
const escapeLike = (text) => text.replace(/[\\%_]/g, "\\$&");

async function list({ status, blocked, sellerId, q, page, limit }) {
  const where = `p.deleted_at IS NULL
    AND ($1::product_status IS NULL OR p.status = $1)
    AND ($2::boolean IS NULL OR (p.blocked_at IS NOT NULL) = $2)
    AND ($3::uuid IS NULL OR p.seller_id = $3)
    AND ($4::text IS NULL OR p.title ILIKE '%' || $4 || '%' OR p.slug = $5)`;
  const params = [status ?? null, blocked ?? null, sellerId ?? null, q ? escapeLike(q) : null, q ?? null];
  const [items, count] = await Promise.all([
    db.query(
      `SELECT p.*, ${STORE_COLUMNS},
              (SELECT COUNT(*)::int FROM product_variants v WHERE v.product_id = p.id AND v.deleted_at IS NULL) AS variant_count,
              (SELECT i.url FROM product_images i WHERE i.product_id = p.id AND i.is_primary) AS primary_image_url
       ${WITH_STORE}
       WHERE ${where}
       ORDER BY p.created_at DESC, p.id DESC
       LIMIT $6 OFFSET $7`,
      [...params, limit, (page - 1) * limit]
    ),
    db.query(`SELECT COUNT(*)::int AS total ${WITH_STORE} WHERE ${where}`, params),
  ]);
  return { rows: items.rows, total: count.rows[0].total };
}

async function findById(id) {
  const { rows } = await db.query(
    `SELECT p.*, ${STORE_COLUMNS} ${WITH_STORE} WHERE p.id = $1 AND p.deleted_at IS NULL`,
    [id]
  );
  return rows[0] ?? null;
}

// Both return false if nothing changed. Checking and changing in one statement means two admins
// acting at once can't overwrite each other's block.
async function block(id, adminId, reason) {
  const { rowCount } = await db.query(
    `UPDATE products SET blocked_at = NOW(), blocked_by = $2, blocked_reason = $3
     WHERE id = $1 AND deleted_at IS NULL AND blocked_at IS NULL`,
    [id, adminId, reason]
  );
  return rowCount > 0;
}

async function unblock(id) {
  const { rowCount } = await db.query(
    `UPDATE products SET blocked_at = NULL, blocked_by = NULL, blocked_reason = NULL
     WHERE id = $1 AND deleted_at IS NULL AND blocked_at IS NOT NULL`,
    [id]
  );
  return rowCount > 0;
}

module.exports = { toAdminProduct, list, findById, block, unblock };
