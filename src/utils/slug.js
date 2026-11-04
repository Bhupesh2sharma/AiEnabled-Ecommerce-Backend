// Turns a name into a URL-friendly code, e.g. "Men's T-Shirts" becomes "men-s-t-shirts".
// Returns an empty string if nothing usable is left, such as for a name only in Hindi script.
function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

module.exports = slugify;
