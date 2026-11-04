// Sellers changing stock and reading its history. Stock can't be set through the variant endpoints.

const db = require("../config/db");
const ProductVariantModel = require("../models/productVariant.model");
const StockModel = require("../models/stock.model");
const ApiError = require("../utils/ApiError");

const variantNotFound = () => new ApiError(404, "Variant not found", { code: "NOT_FOUND" });

// POST /api/seller/variants/:id/stock: returns the updated variant and the history row.
async function changeStock(req, res) {
  const { change, reason, note } = req.body;
  const variantId = req.params.id;
  const sellerId = req.sellerProfile.id;

  const result = await db.transaction(async (client) => {
    const variant = await StockModel.applyChange({ variantId, sellerId, change }, client);

    if (!variant) {
      const current = await ProductVariantModel.findOwned(variantId, sellerId, client);
      if (!current) throw variantNotFound();
      if (change < 0) {
        throw new ApiError(409, `Only ${current.stock_quantity} in stock, so ${-change} can't be removed`, {
          code: "INSUFFICIENT_STOCK",
        });
      }
      throw new ApiError(400, `Stock can't go above ${StockModel.MAX_STOCK}`, { code: "STOCK_LIMIT_REACHED" });
    }

    // Safe in parallel: applyChange above holds the variant's row until this transaction ends.
    if (reason === "initial" && (await StockModel.hasHistory(variantId, client))) {
      throw new ApiError(409, "This variant already has stock history. Use restock or correction", {
        code: "INITIAL_STOCK_ALREADY_SET",
      });
    }

    const movement = await StockModel.record(
      { variantId, change, quantityAfter: variant.stock_quantity, reason, note, createdBy: req.user.id },
      client
    );
    return { variant, movement };
  });

  res.json({
    variant: ProductVariantModel.toSellerVariant(result.variant),
    movement: StockModel.toMovement(result.movement),
  });
}

// GET /api/seller/variants/:id/stock-movements: newest first.
async function listMovements(req, res) {
  const variant = await ProductVariantModel.findOwned(req.params.id, req.sellerProfile.id);
  if (!variant) throw variantNotFound();

  const { page, limit } = req.query;
  const { rows, total } = await StockModel.listForVariant(variant.id, req.query);
  res.json({ movements: rows.map(StockModel.toMovement), pagination: { page, limit, total } });
}

module.exports = { changeStock, listMovements };
