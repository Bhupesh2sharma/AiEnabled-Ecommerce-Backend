const ApiError = require("./ApiError");
const { INDIAN_STATES } = require("./indianStates");

// GST rates a variant can use. Kept in code rather than the database, because rates change by law,
// most recently in September 2025. Have a CA confirm this list before launch.
const GST_RATES = [0, 0.25, 1.5, 3, 5, 18, 40];

// A GSTIN belongs to one state, shown by its first 2 digits, so a store shipping from another state
// would charge the wrong tax. A store has one pickup address, so it ships from one state for now.
// Have a CA confirm this rule.
function assertPickupMatchesGstin(taxId, pickupStateCode) {
  const gstinState = taxId.slice(0, 2);
  if (gstinState === pickupStateCode) return;
  const name = INDIAN_STATES.find((state) => state.code === gstinState)?.name ?? `state code ${gstinState}`;
  throw new ApiError(400, `The pickup address must be in the same state as the GSTIN: ${name}`, {
    code: "PICKUP_STATE_MISMATCH",
  });
}

module.exports = { GST_RATES, assertPickupMatchesGstin };
