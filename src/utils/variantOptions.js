// Checks a variant's chosen options against what its category allows, and converts them to the
// stored form: option code -> value code, with labels kept only for sellers' custom values.

const ApiError = require("./ApiError");
const slugify = require("./slug");

// `allowed` comes from CategoryModel.getEffectiveOptions. `existing` is the variant being edited:
// it can keep a value that has since been removed, but a new variant can't choose one.
function normalizeOptions(allowed, input, existing = { options: {}, optionLabels: {} }) {
  const details = [];
  const options = {};
  const optionLabels = {};
  const allowedCodes = new Set(allowed.map((option) => option.code));

  for (const key of Object.keys(input)) {
    if (!allowedCodes.has(key)) {
      details.push({ field: `options.${key}`, message: "This category doesn't use this option" });
    }
  }

  for (const option of allowed) {
    const raw = input[option.code];
    if (raw === undefined) {
      if (option.isRequired) details.push({ field: `options.${option.code}`, message: `Choose a ${option.name}` });
      continue;
    }

    const code = slugify(raw);
    if (code && option.values.some((value) => value.code === code)) {
      options[option.code] = code;
    } else if (code && existing.options[option.code] === code) {
      options[option.code] = code;
      if (existing.optionLabels[option.code]) optionLabels[option.code] = existing.optionLabels[option.code];
    } else if (code && option.allowCustomValues) {
      options[option.code] = code;
      optionLabels[option.code] = raw;
    } else {
      details.push({ field: `options.${option.code}`, message: `"${raw}" isn't an allowed ${option.name}` });
    }
  }

  if (details.length > 0) {
    throw new ApiError(400, "These options don't match the category", { code: "INVALID_VARIANT_OPTIONS", details });
  }
  return { options, optionLabels };
}

module.exports = normalizeOptions;
