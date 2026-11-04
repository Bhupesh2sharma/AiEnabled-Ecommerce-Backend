// Brands: the public list, and the admin endpoints that manage it.

const BrandModel = require("../models/brand.model");
const ApiError = require("../utils/ApiError");
const slugify = require("../utils/slug");

const notFound = () => new ApiError(404, "Brand not found", { code: "NOT_FOUND" });

function respondWithPage(res, { rows, total }, { page, limit }, toJson) {
  res.json({ brands: rows.map(toJson), pagination: { page, limit, total } });
}

// GET /api/brands: active brands by name; `q` finds names starting with it.
async function list(req, res) {
  const result = await BrandModel.list({ ...req.query, activeOnly: true });
  respondWithPage(res, result, req.query, BrandModel.toPublicBrand);
}

// GET /api/admin/brands: the same list, including inactive brands.
async function adminList(req, res) {
  const result = await BrandModel.list({ ...req.query, activeOnly: false });
  respondWithPage(res, result, req.query, BrandModel.toAdminBrand);
}

// POST /api/admin/brands
async function create(req, res) {
  const slug = req.body.slug ?? slugify(req.body.name);
  if (!slug) {
    throw new ApiError(400, "Validation failed", {
      code: "VALIDATION_ERROR",
      details: [{ field: "slug", message: "Send a slug, because one can't be made from this name" }],
    });
  }
  const brand = await BrandModel.create({ ...req.body, slug });
  res.status(201).json({ brand: BrandModel.toAdminBrand(brand) });
}

// PATCH /api/admin/brands/:id
async function update(req, res) {
  const brand = await BrandModel.update(req.params.id, req.body);
  if (!brand) throw notFound();
  res.json({ brand: BrandModel.toAdminBrand(brand) });
}

// DELETE /api/admin/brands/:id: soft delete, refused while products use the brand.
async function remove(req, res) {
  const result = await BrandModel.softDelete(req.params.id);
  if (result === "not_found") throw notFound();
  if (result === "in_use") {
    throw new ApiError(409, "This brand has products. Deactivate it instead", { code: "BRAND_IN_USE" });
  }
  res.status(204).end();
}

module.exports = { list, adminList, create, update, remove };
