// Picks where files are stored. STORAGE_DRIVER chooses where new uploads go. Both providers can be
// configured at once, so files already on the old provider can still be deleted after a switch.

const env = require("../../config/env");
const ApiError = require("../../utils/ApiError");
const { createR2Driver } = require("./r2");
const { createS3Driver } = require("./s3");

const drivers = {};

if (env.R2_ACCOUNT_ID && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.R2_BUCKET && env.R2_PUBLIC_URL) {
  drivers.r2 = createR2Driver({
    accountId: env.R2_ACCOUNT_ID,
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    bucket: env.R2_BUCKET,
    publicUrl: env.R2_PUBLIC_URL,
  });
}

if (env.S3_REGION && env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY && env.S3_BUCKET && env.S3_PUBLIC_URL) {
  drivers.s3 = createS3Driver({
    region: env.S3_REGION,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    bucket: env.S3_BUCKET,
    publicUrl: env.S3_PUBLIC_URL,
    endpoint: env.S3_ENDPOINT,
  });
}

// The provider for new uploads. Uploads return 503 until one is set up; the rest of the API works without it.
function active() {
  const driver = drivers[env.STORAGE_DRIVER];
  if (!driver) {
    throw new ApiError(503, "Image uploads aren't set up yet", { code: "STORAGE_NOT_CONFIGURED" });
  }
  return driver;
}

module.exports = { drivers, active };
