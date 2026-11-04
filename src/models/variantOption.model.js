// SQL for variant options such as Size, and their allowed values such as S, M, L.

const db = require("../config/db");
const buildAssignments = require("../utils/sqlUpdate");

const OPTION_COLUMNS = { name: "name", allowCustomValues: "allow_custom_values" };
const VALUE_COLUMNS = { label: "label", colorHex: "color_hex", sortOrder: "sort_order" };

function toPublicValue(value) {
  return {
    id: value.id,
    label: value.label,
    code: value.code,
    colorHex: value.color_hex,
    sortOrder: value.sort_order,
  };
}

function toPublicOption(option) {
  return {
    id: option.id,
    name: option.name,
    code: option.code,
    allowCustomValues: option.allow_custom_values,
    ...(option.values && { values: option.values }),
  };
}

// All live options with their live values.
async function listAll() {
  const { rows } = await db.query(
    `SELECT o.*,
            COALESCE(
              JSON_AGG(
                JSON_BUILD_OBJECT('id', v.id, 'label', v.label, 'code', v.code, 'colorHex', v.color_hex, 'sortOrder', v.sort_order)
                ORDER BY v.sort_order, v.label
              ) FILTER (WHERE v.id IS NOT NULL),
              '[]'
            ) AS values
     FROM variant_options o
     LEFT JOIN variant_option_values v ON v.option_id = o.id AND v.deleted_at IS NULL
     WHERE o.deleted_at IS NULL
     GROUP BY o.id
     ORDER BY o.name`
  );
  return rows;
}

async function findById(id) {
  const { rows } = await db.query("SELECT * FROM variant_options WHERE id = $1 AND deleted_at IS NULL", [id]);
  return rows[0] ?? null;
}

async function create({ name, code, allowCustomValues }) {
  const { rows } = await db.query(
    "INSERT INTO variant_options (name, code, allow_custom_values) VALUES ($1, $2, COALESCE($3, FALSE)) RETURNING *",
    [name, code, allowCustomValues ?? null]
  );
  return rows[0];
}

async function update(id, fields) {
  const { assignments, values } = buildAssignments(fields, OPTION_COLUMNS);
  const { rows } = await db.query(
    `UPDATE variant_options SET ${assignments} WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
    [id, ...values]
  );
  return rows[0] ?? null;
}

// Whether a live category uses this option.
async function isUsedByCategory(id, client = db) {
  const { rowCount } = await client.query(
    `SELECT 1 FROM category_variant_options cvo
     JOIN categories c ON c.id = cvo.category_id AND c.deleted_at IS NULL
     WHERE cvo.option_id = $1 LIMIT 1`,
    [id]
  );
  return rowCount === 1;
}

async function softDelete(id, client = db) {
  await client.query("UPDATE variant_options SET deleted_at = NOW() WHERE id = $1", [id]);
}

// How many of these ids are live options, locking them so they can't be deleted mid-transaction.
async function countLive(ids, client) {
  const { rowCount } = await client.query(
    "SELECT 1 FROM variant_options WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL FOR SHARE",
    [ids]
  );
  return rowCount;
}

// Locks an option for the rest of the transaction, stopping a category starting to use it while it's deleted.
async function lockForDelete(id, client) {
  const { rows } = await client.query(
    "SELECT id FROM variant_options WHERE id = $1 AND deleted_at IS NULL FOR UPDATE",
    [id]
  );
  return rows[0] ?? null;
}

async function createValue(optionId, { label, code, colorHex, sortOrder }) {
  const { rows } = await db.query(
    `INSERT INTO variant_option_values (option_id, label, code, color_hex, sort_order)
     VALUES ($1, $2, $3, $4, COALESCE($5, 0))
     RETURNING *`,
    [optionId, label, code, colorHex ?? null, sortOrder ?? null]
  );
  return rows[0];
}

async function updateValue(optionId, valueId, fields) {
  const { assignments, values } = buildAssignments(fields, VALUE_COLUMNS);
  const { rows } = await db.query(
    `UPDATE variant_option_values SET ${assignments}
     WHERE id = $1 AND option_id = $${values.length + 2} AND deleted_at IS NULL
     RETURNING *`,
    [valueId, ...values, optionId]
  );
  return rows[0] ?? null;
}

async function softDeleteValue(optionId, valueId) {
  const { rowCount } = await db.query(
    "UPDATE variant_option_values SET deleted_at = NOW() WHERE id = $1 AND option_id = $2 AND deleted_at IS NULL",
    [valueId, optionId]
  );
  return rowCount === 1;
}

module.exports = {
  toPublicValue,
  toPublicOption,
  listAll,
  findById,
  create,
  update,
  isUsedByCategory,
  softDelete,
  countLive,
  lockForDelete,
  createValue,
  updateValue,
  softDeleteValue,
};
