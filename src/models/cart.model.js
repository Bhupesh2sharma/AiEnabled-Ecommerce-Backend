// SQL for carts. Prices and stock are always read live, never stored. Customers only reach their own
// cart: every lookup here includes the user's id.

const db = require("../config/db");
const { VISIBLE_CATEGORIES, VISIBLE_FROM, VISIBLE_WHERE, DISCOUNT } = require("./browse.model");

// One row per item, with its status worked out here so the totals count exactly the items marked
// available. Money is added up in SQL, because NUMERIC is exact and JavaScript numbers aren't.
async function listForUser(userId, client = db) {
  const { rows } = await client.query(
    `WITH RECURSIVE ${VISIBLE_CATEGORIES},
     on_sale AS (
       SELECT p.id ${VISIBLE_FROM} ${VISIBLE_WHERE}
         AND p.id IN (
           SELECT cv.product_id FROM cart_items ci
           JOIN product_variants cv ON cv.id = ci.variant_id
           WHERE ci.user_id = $1
         )
     ),
     lines AS (
       SELECT ci.variant_id, ci.quantity, ci.created_at,
              v.options, v.option_labels, v.stock_quantity, v.selling_price, v.mrp, ${DISCOUNT},
              p.id AS product_id, p.slug, p.title,
              s.store_name, s.store_slug,
              CASE
                WHEN NOT v.is_active OR v.deleted_at IS NOT NULL OR p.id NOT IN (SELECT id FROM on_sale) THEN 'unavailable'
                WHEN v.stock_quantity = 0 THEN 'out_of_stock'
                WHEN v.stock_quantity < ci.quantity THEN 'not_enough_stock'
                ELSE 'available'
              END AS status
       FROM cart_items ci
       JOIN product_variants v ON v.id = ci.variant_id
       JOIN products p ON p.id = v.product_id
       JOIN seller_profiles s ON s.id = p.seller_id
       WHERE ci.user_id = $1
     )
     SELECT l.*,
            image.url AS image_url, image.alt_text AS image_alt_text,
            (l.selling_price * l.quantity)::numeric(16, 2) AS line_total,
            COALESCE(SUM(l.quantity) FILTER (WHERE l.status = 'available') OVER (), 0)::int AS item_count,
            COALESCE(SUM(l.selling_price * l.quantity) FILTER (WHERE l.status = 'available') OVER (), 0)::numeric(16, 2) AS subtotal,
            COALESCE(SUM(l.mrp * l.quantity) FILTER (WHERE l.status = 'available') OVER (), 0)::numeric(16, 2) AS mrp_total,
            COALESCE(SUM((l.mrp - l.selling_price) * l.quantity) FILTER (WHERE l.status = 'available') OVER (), 0)::numeric(16, 2) AS savings
     FROM lines l
     LEFT JOIN LATERAL (
       -- The variant's own photo if it has one, otherwise the product's main image.
       SELECT i.url, i.alt_text FROM product_images i
       WHERE i.product_id = l.product_id
       ORDER BY (i.variant_id IS NOT DISTINCT FROM l.variant_id) DESC, i.is_primary DESC, i.sort_order, i.created_at
       LIMIT 1
     ) image ON TRUE
     ORDER BY l.created_at DESC, l.variant_id`,
    [userId]
  );
  return rows;
}

// A variant's stock if it's on sale, or null if customers can't buy it for any reason.
async function findStockIfOnSale(variantId, client) {
  const { rows } = await client.query(
    `WITH RECURSIVE ${VISIBLE_CATEGORIES}
     SELECT sale.stock_quantity
     ${VISIBLE_FROM}
     JOIN product_variants sale ON sale.product_id = p.id
     ${VISIBLE_WHERE} AND sale.id = $1 AND sale.deleted_at IS NULL AND sale.is_active`,
    [variantId]
  );
  return rows[0]?.stock_quantity ?? null;
}

async function findQuantity(userId, variantId, client) {
  const { rows } = await client.query("SELECT quantity FROM cart_items WHERE user_id = $1 AND variant_id = $2", [
    userId,
    variantId,
  ]);
  return rows[0]?.quantity ?? null;
}

async function countItems(userId, client) {
  const { rows } = await client.query("SELECT COUNT(*)::int AS count FROM cart_items WHERE user_id = $1", [userId]);
  return rows[0].count;
}

// Adds the row, or sets the quantity if it's already there.
async function setQuantity(userId, variantId, quantity, client) {
  await client.query(
    `INSERT INTO cart_items (user_id, variant_id, quantity) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, variant_id) DO UPDATE SET quantity = EXCLUDED.quantity`,
    [userId, variantId, quantity]
  );
}

module.exports = { listForUser, findStockIfOnSale, findQuantity, countItems, setQuantity };
