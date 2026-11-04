// Admin endpoints for variant options such as Size, and their values such as S, M, L.
// Variants store each option's and value's `code`, so codes can't change but names and labels can.

const db = require("../config/db");
const VariantOptionModel = require("../models/variantOption.model");
const ApiError = require("../utils/ApiError");
const slugify = require("../utils/slug");

const optionNotFound = () => new ApiError(404, "Variant option not found", { code: "NOT_FOUND" });
const valueNotFound = () => new ApiError(404, "Option value not found", { code: "NOT_FOUND" });

function codeOrThrow(code, source) {
  const result = code ?? slugify(source);
  if (!result) {
    throw new ApiError(400, "Validation failed", {
      code: "VALIDATION_ERROR",
      details: [{ field: "code", message: "Send a code, because one can't be made from this text" }],
    });
  }
  return result;
}

// GET /api/admin/variant-options
async function list(req, res) {
  const options = await VariantOptionModel.listAll();
  res.json({ options: options.map(VariantOptionModel.toPublicOption) });
}

// POST /api/admin/variant-options
async function create(req, res) {
  const option = await VariantOptionModel.create({ ...req.body, code: codeOrThrow(req.body.code, req.body.name) });
  res.status(201).json({ option: VariantOptionModel.toPublicOption(option) });
}

// PATCH /api/admin/variant-options/:id
async function update(req, res) {
  const option = await VariantOptionModel.update(req.params.id, req.body);
  if (!option) throw optionNotFound();
  res.json({ option: VariantOptionModel.toPublicOption(option) });
}

// DELETE /api/admin/variant-options/:id: refused while a category uses it. Existing variants keep their stored codes.
async function remove(req, res) {
  const { id } = req.params;
  await db.transaction(async (client) => {
    if (!(await VariantOptionModel.lockForDelete(id, client))) throw optionNotFound();
    if (await VariantOptionModel.isUsedByCategory(id, client)) {
      throw new ApiError(409, "Remove this option from its categories first", { code: "OPTION_IN_USE" });
    }
    await VariantOptionModel.softDelete(id, client);
  });
  res.status(204).end();
}

// POST /api/admin/variant-options/:id/values
async function createValue(req, res) {
  const option = await VariantOptionModel.findById(req.params.id);
  if (!option) throw optionNotFound();
  const value = await VariantOptionModel.createValue(option.id, {
    ...req.body,
    code: codeOrThrow(req.body.code, req.body.label),
  });
  res.status(201).json({ value: VariantOptionModel.toPublicValue(value) });
}

// PATCH /api/admin/variant-options/:id/values/:valueId
async function updateValue(req, res) {
  const value = await VariantOptionModel.updateValue(req.params.id, req.params.valueId, req.body);
  if (!value) throw valueNotFound();
  res.json({ value: VariantOptionModel.toPublicValue(value) });
}

// DELETE /api/admin/variant-options/:id/values/:valueId: new variants can't use it; existing ones keep it.
async function removeValue(req, res) {
  if (!(await VariantOptionModel.softDeleteValue(req.params.id, req.params.valueId))) throw valueNotFound();
  res.status(204).end();
}

module.exports = { list, create, update, remove, createValue, updateValue, removeValue };
