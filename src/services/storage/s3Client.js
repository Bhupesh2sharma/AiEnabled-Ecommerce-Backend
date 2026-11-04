// Shared code for S3-compatible storage. R2 speaks the S3 API, so both drivers differ only in their settings.

const {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const ApiError = require("../../utils/ApiError");

const UPLOAD_URL_SECONDS = 5 * 60;
const SIGNATURE_BYTES = 12;

function storageError(err) {
  console.error("Storage request failed:", err);
  return new ApiError(502, "File storage is unavailable. Try again shortly", { code: "STORAGE_ERROR" });
}

const isMissing = (err) => err.name === "NotFound" || err.name === "NoSuchKey" || err.$metadata?.httpStatusCode === 404;

function createDriver({ provider, bucket, publicUrl, clientConfig }) {
  const client = new S3Client({
    ...clientConfig,
    // Newer SDK versions add checksums by default, which would break presigned uploads on R2.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
  const baseUrl = publicUrl.replace(/\/+$/, "");

  return {
    provider,
    uploadUrlSeconds: UPLOAD_URL_SECONDS,

    publicUrlFor: (key) => `${baseUrl}/${key}`,

    // A URL the browser can PUT one file to. The content type is signed, so a different one is refused.
    async createUploadUrl(key, contentType) {
      try {
        return await getSignedUrl(client, new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType }), {
          expiresIn: UPLOAD_URL_SECONDS,
          signableHeaders: new Set(["content-type"]),
        });
      } catch (err) {
        throw storageError(err);
      }
    },

    // The file's real size and type, plus its first bytes for identifying it. Null if it doesn't exist.
    async inspect(key) {
      try {
        const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        const info = { sizeBytes: head.ContentLength, contentType: head.ContentType, firstBytes: Buffer.alloc(0) };
        if (head.ContentLength > 0) {
          const part = await client.send(
            new GetObjectCommand({ Bucket: bucket, Key: key, Range: `bytes=0-${SIGNATURE_BYTES - 1}` })
          );
          info.firstBytes = Buffer.from(await part.Body.transformToByteArray());
        }
        return info;
      } catch (err) {
        if (isMissing(err)) return null;
        throw storageError(err);
      }
    },

    async remove(key) {
      try {
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
      } catch (err) {
        throw storageError(err);
      }
    },
  };
}

module.exports = { createDriver };
