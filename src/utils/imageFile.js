// Which image files can be uploaded, and how to recognise them from their first bytes.

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const IMAGE_TYPES = {
  "image/jpeg": { extension: "jpg", matches: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  "image/png": {
    extension: "png",
    matches: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  "image/webp": {
    extension: "webp",
    matches: (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP",
  },
};

// A file's declared type can't be trusted, because it's whatever the uploader said. So the
// first bytes must match too, which stops an HTML page being stored as an "image".
function checkImage({ sizeBytes, contentType, firstBytes }) {
  const type = IMAGE_TYPES[contentType];
  if (!type) return "Only JPEG, PNG and WebP images are allowed";
  if (!sizeBytes || sizeBytes > MAX_IMAGE_BYTES) return "Images must be 5 MB or smaller";
  if (!type.matches(firstBytes)) return "This file isn't a valid image";
  return null;
}

module.exports = { MAX_IMAGE_BYTES, IMAGE_TYPES, checkImage };
