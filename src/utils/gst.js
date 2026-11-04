// GST rates a variant can use. Kept in code rather than the database, because rates change by law,
// most recently in September 2025. Have a CA confirm this list before launch.
const GST_RATES = [0, 0.25, 1.5, 3, 5, 18, 40];

module.exports = { GST_RATES };
