// A customer's cart. Nothing is held: prices and stock are read live on every view, and stock is only
// taken when an order is placed. Only customers reach this, in cart.routes.js.
//
// Responses are built field by field, so seller-only data (exact stock, SKUs, GST details, why a product
// is hidden) can't reach customers by accident when a column is added.

const db = require("../config/db");
const BrowseModel = require("../models/browse.model");
const CartModel = require("../models/cart.model");
const UserModel = require("../models/user.model");
const ApiError = require("../utils/ApiError");

const MAX_PER_ITEM = 10;
const MAX_ITEMS = 50;

// Readable options, such as "Size: M". A seller's custom value carries its own label on the variant.
function toOptions(row, labels) {
  return Object.entries(row.options)
    .map(([optionCode, valueCode]) => {
      const known = labels.filter((label) => label.option_code === optionCode);
      const value = known.find((label) => label.value_code === valueCode);
      return {
        name: known[0]?.option_name ?? optionCode,
        label: value?.label ?? row.option_labels[optionCode] ?? valueCode,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

// `maxQuantity` is the smaller of the limit and the stock, so exact stock above the limit stays private.
// An unavailable item has no price, because it can't be bought at any price.
function toItem(row, labels) {
  const unavailable = row.status === "unavailable";
  return {
    variantId: row.variant_id,
    quantity: row.quantity,
    status: row.status,
    maxQuantity: unavailable ? 0 : Math.min(MAX_PER_ITEM, row.stock_quantity),
    productId: row.product_id,
    slug: row.slug,
    title: row.title,
    image: row.image_url ? { url: row.image_url, altText: row.image_alt_text } : null,
    options: toOptions(row, labels),
    store: { name: row.store_name, slug: row.store_slug },
    price: unavailable ? null : row.selling_price,
    mrp: unavailable ? null : row.mrp,
    discountPercent: unavailable ? null : row.discount_percent,
    lineTotal: unavailable ? null : row.line_total,
  };
}

async function buildCart(userId) {
  const rows = await CartModel.listForUser(userId);
  const optionCodes = [...new Set(rows.flatMap((row) => Object.keys(row.options)))];
  const labels = optionCodes.length > 0 ? await BrowseModel.findOptionLabels(optionCodes) : [];
  const first = rows[0];
  return {
    items: rows.map((row) => toItem(row, labels)),
    totals: {
      itemCount: first?.item_count ?? 0,
      subtotal: first?.subtotal ?? "0.00",
      mrpTotal: first?.mrp_total ?? "0.00",
      savings: first?.savings ?? "0.00",
    },
    // All or nothing, so nothing is dropped from an order without the customer seeing it.
    canCheckout: rows.length > 0 && rows.every((row) => row.status === "available"),
  };
}

// GET /api/cart
async function getCart(req, res) {
  res.json(await buildCart(req.user.id));
}

// Tells the customer how many they can have, for a stock or limit problem.
function quantityError(message, code, maxQuantity) {
  return new ApiError(409, message, {
    code,
    details: [{ field: "quantity", message, maxQuantity }],
  });
}

// POST /api/cart/items: adding a variant already in the cart adds to its quantity.
async function addItem(req, res) {
  const { variantId, quantity } = req.body;

  await db.transaction(async (client) => {
    await UserModel.lockForChange(req.user.id, client);

    // The same answer for a hidden variant and an unknown one, so hidden products can't be discovered.
    const stock = await CartModel.findStockIfOnSale(variantId, client);
    if (stock === null) throw new ApiError(409, "This product isn't available", { code: "PRODUCT_UNAVAILABLE" });
    if (stock === 0) throw new ApiError(409, "This product is out of stock", { code: "OUT_OF_STOCK" });

    const current = await CartModel.findQuantity(req.user.id, variantId, client);
    if (current === null && (await CartModel.countItems(req.user.id, client)) >= MAX_ITEMS) {
      throw new ApiError(409, `Your cart can hold at most ${MAX_ITEMS} different items`, {
        code: "CART_LIMIT_REACHED",
      });
    }

    const total = (current ?? 0) + quantity;
    const maxQuantity = Math.min(MAX_PER_ITEM, stock);
    if (total > stock) {
      throw quantityError(`Only ${maxQuantity} of this item can be in your cart`, "NOT_ENOUGH_STOCK", maxQuantity);
    }
    if (total > MAX_PER_ITEM) {
      throw quantityError(`You can have at most ${MAX_PER_ITEM} of each item`, "QUANTITY_LIMIT_REACHED", maxQuantity);
    }

    await CartModel.setQuantity(req.user.id, variantId, total, client);
  });

  res.json(await buildCart(req.user.id));
}

module.exports = { getCart, addItem };
