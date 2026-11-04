// Tests the real storage code. The URL checks need no network or account.
// The upload tests run against any S3-compatible server when these are set, and are skipped otherwise:
//   TEST_S3_ENDPOINT, TEST_S3_ACCESS_KEY, TEST_S3_SECRET_KEY, TEST_S3_BUCKET

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { CreateBucketCommand, S3Client } = require("@aws-sdk/client-s3");

process.env.DATABASE_URL ??= "postgres://unused";
process.env.JWT_ACCESS_SECRET ??= "unused";

const { createR2Driver } = require("../src/services/storage/r2");
const { createS3Driver } = require("../src/services/storage/s3");

const KEY = "products/seller/file.png";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

const r2 = () =>
  createR2Driver({
    accountId: "acct123",
    accessKeyId: "dummy",
    secretAccessKey: "dummy",
    bucket: "shop",
    publicUrl: "https://images.shop.test/",
  });

test("R2 upload URLs use the account's endpoint, sign the type and add no checksum", async () => {
  const url = new URL(await r2().createUploadUrl(KEY, "image/png"));
  assert.equal(url.host, "shop.acct123.r2.cloudflarestorage.com");
  assert.equal(url.pathname, `/${KEY}`);
  assert.equal(url.searchParams.get("X-Amz-Expires"), "300");
  assert.match(url.searchParams.get("X-Amz-Credential"), /\/auto\/s3\/aws4_request$/);
  assert.match(url.searchParams.get("X-Amz-SignedHeaders"), /content-type/);
  for (const name of url.searchParams.keys()) {
    assert.ok(!/checksum/i.test(name), `unexpected ${name}: R2 rejects these`);
  }
  assert.equal(url.searchParams.get("x-id"), "PutObject");
});

test("public URLs are built without doubled slashes, for both providers", () => {
  assert.equal(r2().publicUrlFor(KEY), `https://images.shop.test/${KEY}`);
  const s3 = createS3Driver({ region: "ap-south-1", accessKeyId: "d", secretAccessKey: "d", bucket: "b", publicUrl: "https://cdn.test" });
  assert.equal(s3.publicUrlFor(KEY), `https://cdn.test/${KEY}`);
  assert.equal(s3.provider, "s3");
  assert.equal(r2().provider, "r2");
});

test("AWS S3 upload URLs use the configured region", async () => {
  const s3 = createS3Driver({ region: "ap-south-1", accessKeyId: "d", secretAccessKey: "d", bucket: "shop", publicUrl: "https://cdn.test" });
  const url = new URL(await s3.createUploadUrl(KEY, "image/png"));
  assert.equal(url.host, "shop.s3.ap-south-1.amazonaws.com");
  assert.match(url.searchParams.get("X-Amz-SignedHeaders"), /content-type/);
});

const { TEST_S3_ENDPOINT: endpoint, TEST_S3_ACCESS_KEY: accessKeyId, TEST_S3_SECRET_KEY: secretAccessKey, TEST_S3_BUCKET: bucket } = process.env;
const live = { skip: endpoint ? false : "TEST_S3_ENDPOINT isn't set" };

function liveDriver() {
  return createS3Driver({ region: "us-east-1", accessKeyId, secretAccessKey, bucket, publicUrl: "https://cdn.test", endpoint });
}

async function ensureBucket() {
  const client = new S3Client({ region: "us-east-1", endpoint, forcePathStyle: true, credentials: { accessKeyId, secretAccessKey } });
  await client.send(new CreateBucketCommand({ Bucket: bucket })).catch((err) => {
    if (err.name !== "BucketAlreadyOwnedByYou" && err.name !== "BucketAlreadyExists") throw err;
  });
}

test("a real file uploads with the URL, can be inspected, and deleted", live, async () => {
  await ensureBucket();
  const driver = liveDriver();
  const key = `tests/${Date.now()}.png`;
  assert.equal(await driver.inspect(key), null);

  const url = await driver.createUploadUrl(key, "image/png");
  const put = await fetch(url, { method: "PUT", headers: { "Content-Type": "image/png" }, body: PNG });
  assert.equal(put.status, 200, await put.text());

  const info = await driver.inspect(key);
  assert.equal(info.sizeBytes, PNG.length);
  assert.equal(info.contentType, "image/png");
  assert.equal(info.firstBytes.length, 12);
  assert.ok(info.firstBytes.equals(PNG.subarray(0, 12)));

  await driver.remove(key);
  assert.equal(await driver.inspect(key), null);
});

test("an upload is refused if it uses a different type from the one signed", live, async () => {
  await ensureBucket();
  const driver = liveDriver();
  const key = `tests/${Date.now()}-type.png`;
  const url = await driver.createUploadUrl(key, "image/png");
  const put = await fetch(url, { method: "PUT", headers: { "Content-Type": "text/html" }, body: "<script></script>" });
  assert.equal(put.status, 403);
  assert.equal(await driver.inspect(key), null);
});

test("an upload URL can't be used for a different file", live, async () => {
  await ensureBucket();
  const driver = liveDriver();
  const stamp = Date.now();
  const url = new URL(await driver.createUploadUrl(`tests/${stamp}-a.png`, "image/png"));
  url.pathname = url.pathname.replace(`${stamp}-a`, `${stamp}-b`);
  const put = await fetch(url, { method: "PUT", headers: { "Content-Type": "image/png" }, body: PNG });
  assert.equal(put.status, 403);
});

test("inspecting an empty file reports size 0 without failing", live, async () => {
  await ensureBucket();
  const driver = liveDriver();
  const key = `tests/${Date.now()}-empty.png`;
  const url = await driver.createUploadUrl(key, "image/png");
  assert.equal((await fetch(url, { method: "PUT", headers: { "Content-Type": "image/png" }, body: "" })).status, 200);
  const info = await driver.inspect(key);
  assert.equal(info.sizeBytes, 0);
  await driver.remove(key);
});

test("when the server can't be reached, callers get a clear storage error", async () => {
  const dead = createS3Driver({
    region: "us-east-1",
    accessKeyId: "d",
    secretAccessKey: "d",
    bucket: "b",
    publicUrl: "https://cdn.test",
    endpoint: "http://127.0.0.1:9",
  });
  const logged = console.error;
  console.error = () => {};
  try {
    await assert.rejects(dead.inspect("x"), (err) => err.code === "STORAGE_ERROR" && err.status === 502);
  } finally {
    console.error = logged;
  }
});
