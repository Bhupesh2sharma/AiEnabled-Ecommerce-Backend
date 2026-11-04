// Cloudflare R2. Needs R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET and R2_PUBLIC_URL.

const { createDriver } = require("./s3Client");

const createR2Driver = ({ accountId, accessKeyId, secretAccessKey, bucket, publicUrl }) =>
  createDriver({
    provider: "r2",
    bucket,
    publicUrl,
    clientConfig: {
      region: "auto", // the SDK requires a region, but R2 doesn't use it
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId, secretAccessKey },
    },
  });

module.exports = { createR2Driver };
