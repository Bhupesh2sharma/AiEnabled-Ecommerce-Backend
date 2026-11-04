// SQL for product variants. Stock isn't changed here: it has its own function with a history (step 5).

const db = require("../config/db");
const buildAssignments = require("../utils/sqlUpdate");

const COLUMNS = {
  sku: "sku",
  options: "options",
  optionLabels: "option_labels",
  mrp: "mrp",
  sellingPrice: "selling_price",
  gstRate: "gst_rate",
  netQuantity: "net_quantity",
  weightGrams: "weight_grams",
  lengthMm: "length_mm",
  widthMm: "width_mm",
  heightMm: "height_mm",
  lowStockThreshold: "low_stock_threshold",
  barcode: "barcode",
  isActive: "is_active",
};

function toSellerVariant(variant) {
  return {
    id: variant.id,
    productId: variant.product_id,
    sku: variant.sku,
    options: variant.options,
    optionLabels: variant.option_labels,
    mrp: variant.mrp,
    sellingPrice: variant.selling_price,
    gstRate: variant.gst_rate,
    netQuantity: variant.net_quantity,
    weightGrams: variant.weight_grams,
    lengthMm: variant.length_mm,
    widthMm: variant.width_mm,
    heightMm: variant.height_mm,
    stockQuantity: variant.stock_quantity,
    lowStockThreshold: variant.low_stock_threshold,
    barcode: variant.barcode,
    isActive: variant.is_active,
    createdAt: variant.created_at,
    updatedAt: variant.updated_at,
  };
}

// JSONB values must be sent as JSON text: the pg library would turn a JavaScript array into a
// Postgres array, which could reach the column as {}.
function toParams(fields) {
  const params = { ...fields };
  if (fields.options !== undefined) params.options = JSON.stringify(fields.options);
  if (fields.optionLabels !== undefined) params.optionLabels = JSON.stringify(fields.optionLabels);
  return params;
}

async function create(product, fields, client) {
  const params = toParams(fields);
  const { rows } = await client.query(
    `INSERT INTO product_variants (
       product_id, seller_id, sku, options, option_labels, mrp, selling_price, gst_rate, net_quantity,
       weight_grams, length_mm, width_mm, height_mm, low_stock_threshold, barcode, is_active
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, 0), $9, $10, $11, $12, $13, COALESCE($14, 5), $15, COALESCE($16, TRUE))
     RETURNING *`,
    [
      product.id,
      product.seller_id,
      params.sku,
      params.options,
      params.optionLabels,
      params.mrp,
      params.sellingPrice,
      params.gstRate ?? null,
      params.netQuantity ?? null,
      params.weightGrams ?? null,
      params.lengthMm ?? null,
      params.widthMm ?? null,
      params.heightMm ?? null,
      params.lowStockThreshold ?? null,
      params.barcode ?? null,
      params.isActive ?? null,
    ]
  );
  return rows[0];
}

async function listForProduct(productId, client = db) {
  const { rows } = await client.query(
    "SELECT * FROM product_variants WHERE product_id = $1 AND deleted_at IS NULL ORDER BY created_at",
    [productId]
  );
  return rows;
}

async function countForProduct(productId, client) {
  const { rows } = await client.query(
    "SELECT COUNT(*)::int AS count FROM product_variants WHERE product_id = $1 AND deleted_at IS NULL",
    [productId]
  );
  return rows[0].count;
}

async function findOwned(id, sellerId, client = db) {
  const { rows } = await client.query(
    "SELECT * FROM product_variants WHERE id = $1 AND seller_id = $2 AND deleted_at IS NULL",
    [id, sellerId]
  );
  return rows[0] ?? null;
}

async function update(id, fields, client) {
  const { assignments, values } = buildAssignments(toParams(fields), COLUMNS);
  const { rows } = await client.query(`UPDATE product_variants SET ${assignments} WHERE id = $1 RETURNING *`, [
    id,
    ...values,
  ]);
  return rows[0];
}

async function softDelete(id, client) {
  await client.query("UPDATE product_variants SET deleted_at = NOW() WHERE id = $1", [id]);
}

module.exports = { toSellerVariant, create, listForProduct, countForProduct, findOwned, update, softDelete };
