// The only place stock changes. Each change updates the variant and adds a history row together,
// so stock_quantity always equals the sum of its history. Must run inside a transaction.

const db = require("../config/db");

const MAX_STOCK = 1000000000;

function toMovement(row) {
  return {
    id: row.id,
    variantId: row.variant_id,
    change: row.change,
    quantityAfter: row.quantity_after,
    reason: row.reason,
    note: row.note,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

// Adds `change` (negative removes) in one statement, so parallel changes can't overwrite each other.
// The row stays locked until the transaction ends. Returns null if this would go below 0 or above the limit.
async function applyChange({ variantId, sellerId, change }, client) {
  const { rows } = await client.query(
    `UPDATE product_variants
     SET stock_quantity = stock_quantity + $3
     WHERE id = $1 AND seller_id = $2 AND deleted_at IS NULL
       AND stock_quantity + $3::bigint BETWEEN 0 AND $4
     RETURNING *`,
    [variantId, sellerId, change, MAX_STOCK]
  );
  return rows[0] ?? null;
}

async function record({ variantId, change, quantityAfter, reason, note, createdBy }, client) {
  const { rows } = await client.query(
    `INSERT INTO stock_movements (variant_id, change, quantity_after, reason, note, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [variantId, change, quantityAfter, reason, note ?? null, createdBy]
  );
  return rows[0];
}

async function hasHistory(variantId, client) {
  const { rowCount } = await client.query("SELECT 1 FROM stock_movements WHERE variant_id = $1 LIMIT 1", [variantId]);
  return rowCount === 1;
}

// Newest first.
async function listForVariant(variantId, { page, limit }) {
  const [items, count] = await Promise.all([
    db.query(
      "SELECT * FROM stock_movements WHERE variant_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3",
      [variantId, limit, (page - 1) * limit]
    ),
    db.query("SELECT COUNT(*)::int AS total FROM stock_movements WHERE variant_id = $1", [variantId]),
  ]);
  return { rows: items.rows, total: count.rows[0].total };
}

module.exports = { MAX_STOCK, toMovement, applyChange, record, hasHistory, listForVariant };
