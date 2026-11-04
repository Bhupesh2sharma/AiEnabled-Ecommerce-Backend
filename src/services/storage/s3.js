// AWS S3. Needs S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_BUCKET and S3_PUBLIC_URL.
// S3_ENDPOINT is optional, for S3-compatible servers such as MinIO in testing.

const { createDriver } = require("./s3Client");

const createS3Driver = ({ region, accessKeyId, secretAccessKey, bucket, publicUrl, endpoint }) =>
  createDriver({
    provider: "s3",
    bucket,
    publicUrl,
    clientConfig: {
      region,
      credentials: { accessKeyId, secretAccessKey },
      ...(endpoint && { endpoint, forcePathStyle: true }),
    },
  });

module.exports = { createS3Driver };
