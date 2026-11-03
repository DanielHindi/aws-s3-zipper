'use strict';

/**
 * End-to-end tests over real HTTP against an S3-compatible endpoint.
 *
 * Set S3ZIPPER_TEST_ENDPOINT (plus S3ZIPPER_TEST_ACCESS_KEY,
 * S3ZIPPER_TEST_SECRET_KEY and optionally S3ZIPPER_TEST_BUCKET /
 * S3ZIPPER_TEST_REGION) to run against MinIO or S3. Without it, an in-process
 * S3-compatible server from ./fake-s3-server.js is started so the SDK's
 * request/response pipeline is still exercised for real (no client mocks).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  S3Client,
  CreateBucketCommand,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
} = require('@aws-sdk/client-s3');
const S3Zipper = require('..');
const { collector, readZip } = require('./helpers');
const { FakeS3Server } = require('./fake-s3-server');

const MB = 1024 * 1024;
const RUN = `it-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;

async function setup() {
  const env = process.env;
  let fake = null;
  let endpoint = env.S3ZIPPER_TEST_ENDPOINT;
  let credentials = { accessKeyId: env.S3ZIPPER_TEST_ACCESS_KEY, secretAccessKey: env.S3ZIPPER_TEST_SECRET_KEY };

  if (!endpoint) {
    fake = new FakeS3Server();
    endpoint = await fake.listen();
    credentials = { accessKeyId: 'fake', secretAccessKey: 'fake' };
  }

  const bucket = env.S3ZIPPER_TEST_BUCKET || 'aws-s3-zipper-test';
  const region = env.S3ZIPPER_TEST_REGION || 'us-east-1';
  const client = new S3Client({ endpoint, region, credentials, forcePathStyle: true });

  try {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
  } catch (err) {
    if (!/BucketAlreadyOwnedByYou|BucketAlreadyExists/.test(err.name)) throw err;
  }

  return { fake, endpoint, credentials, bucket, region, client, kind: fake ? 'in-process fake' : endpoint };
}

async function seed(client, bucket, objects) {
  for (const [key, body] of Object.entries(objects)) {
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body }));
  }
}

async function getObjectBuffer(client, bucket, key) {
  const { Body } = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return Buffer.from(await Body.transformToByteArray());
}

async function cleanup(client, bucket, prefix) {
  let token;
  do {
    const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
    const keys = (page.Contents || []).map((o) => ({ Key: o.Key }));
    if (keys.length) await client.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys } }));
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
}

test('integration', async (t) => {
  const ctx = await setup();
  t.diagnostic(`endpoint: ${ctx.kind}`);

  const big = crypto.randomBytes(6 * MB); // forces a multipart upload with a 5 MB part size
  const SMALL = {};
  for (let i = 0; i < 12; i += 1) SMALL[`${RUN}/photos/img-${String(i).padStart(2, '0')}.txt`] = `image ${i}`;
  SMALL[`${RUN}/photos/nested/deep.txt`] = 'deep';
  SMALL[`${RUN}/photos/skip.tmp`] = 'temp';
  SMALL[`${RUN}/other/elsewhere.txt`] = 'elsewhere';

  await seed(ctx.client, ctx.bucket, { ...SMALL, [`${RUN}/photos/big.bin`]: big });

  const zipper = new S3Zipper({
    bucket: ctx.bucket,
    region: ctx.region,
    endpoint: ctx.endpoint,
    forcePathStyle: true,
    ...ctx.credentials,
    uploadOptions: { partSize: 5 * MB, queueSize: 2 },
    concurrency: 3,
  });
  zipper.filterOutFiles = (f) => (f.Key.endsWith('.tmp') ? null : f);

  t.after(async () => {
    await cleanup(ctx.client, ctx.bucket, `${RUN}/`);
    ctx.client.destroy();
    if (ctx.fake) await ctx.fake.close();
  });

  await t.test('getFiles lists through real pagination and honours delimiter', async () => {
    const paged = new S3Zipper({ ...zipperOptions(ctx), pageSize: 4 });
    const flat = await paged.getFiles({ prefix: `${RUN}/photos` });
    assert.equal(flat.files.length, 14, 'non-recursive excludes nested/');
    const deep = await paged.getFiles({ prefix: `${RUN}/photos`, recursive: true });
    assert.equal(deep.files.length, 15);
    assert.ok(deep.files.some((f) => f.Key.endsWith('nested/deep.txt')));
  });

  await t.test('streamZipDataTo produces a valid zip over HTTP', async () => {
    const out = collector();
    const result = await zipper.streamZipDataTo({ pipe: out, prefix: `${RUN}/photos`, recursive: true });
    const entries = await readZipBinary(out.buffer());
    assert.equal(result.zippedFiles.length, 14);
    assert.equal(entries['img-00.txt'].toString(), 'image 0');
    assert.equal(entries['nested/deep.txt'].toString(), 'deep');
    assert.ok(!('skip.tmp' in entries));
    assert.ok(entries['big.bin'].equals(big), 'binary payload survived the zip stream');
  });

  await t.test('zipToS3File streams a multipart upload and the result round-trips', async () => {
    const result = await zipper.zipToS3File({ prefix: `${RUN}/photos`, key: `${RUN}/out/all.zip`, recursive: true });
    assert.equal(result.key, `${RUN}/out/all.zip`);
    assert.ok(result.etag);

    const zipBytes = await getObjectBuffer(ctx.client, ctx.bucket, result.key);
    assert.ok(zipBytes.length > 5 * MB, 'zip is larger than one part');
    const entries = await readZipBinary(zipBytes);
    assert.equal(Object.keys(entries).length, 14);
    assert.ok(entries['big.bin'].equals(big), 'binary payload survived zip + multipart upload');

    if (ctx.fake) {
      const posts = ctx.fake.requests.filter((r) => r.method === 'POST' && 'uploads' in r.query);
      assert.ok(posts.length >= 1, 'CreateMultipartUpload was used');
    }
  });

  await t.test('zipToS3FileFragments uploads numbered fragments', async () => {
    const results = await zipper.zipToS3FileFragments({
      prefix: `${RUN}/photos`,
      key: `${RUN}/frags/photos.zip`,
      maxFileCount: 5,
    });
    assert.deepEqual(
      results.map((r) => r.key),
      [1, 2, 3].map((n) => `${RUN}/frags/photos_${n}.zip`),
    );
    const listed = await ctx.client.send(new ListObjectsV2Command({ Bucket: ctx.bucket, Prefix: `${RUN}/frags/` }));
    assert.equal(listed.Contents.length, 3);
  });

  await t.test('zipToFile writes a local file and differential zipping resumes', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's3zipper-it-'));
    const first = await zipper.zipToFile({ prefix: `${RUN}/photos`, filePath: path.join(dir, 'a.zip'), maxFileCount: 6 });
    const second = await zipper.zipToFile({
      prefix: `${RUN}/photos`,
      filePath: path.join(dir, 'b.zip'),
      startKey: first.lastScannedFile.Key,
    });
    const names = [...Object.keys(await readZip(fs.readFileSync(first.filePath))), ...Object.keys(await readZip(fs.readFileSync(second.filePath)))];
    assert.equal(new Set(names).size, names.length, 'no overlap between runs');
    assert.equal(names.length, 13, 'big.bin + 12 images; nested/ excluded, skip.tmp filtered');
  });

  await t.test('an empty prefix uploads nothing', async () => {
    const result = await zipper.zipToS3File({ prefix: `${RUN}/nothing-here`, key: `${RUN}/out/empty.zip` });
    assert.equal(result.key, null);
    const listed = await ctx.client.send(new ListObjectsV2Command({ Bucket: ctx.bucket, Prefix: `${RUN}/out/empty.zip` }));
    assert.equal(listed.KeyCount ?? (listed.Contents || []).length, 0);
  });

  await t.test('abort cancels an in-progress zip', async () => {
    const controller = new AbortController();
    const out = collector();
    const p = zipper.streamZipDataTo({ pipe: out, prefix: `${RUN}/photos`, recursive: true, signal: controller.signal });
    setTimeout(() => controller.abort(), 5);
    await assert.rejects(p, { name: 'AbortError' });
  });
});

function zipperOptions(ctx) {
  return {
    bucket: ctx.bucket,
    region: ctx.region,
    endpoint: ctx.endpoint,
    forcePathStyle: true,
    ...ctx.credentials,
  };
}

/** Like helpers.readZip but keeps entry contents as Buffers. */
function readZipBinary(buffer) {
  const yauzl = require('yauzl');
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zipfile) => {
      if (err) return reject(err);
      const entries = {};
      zipfile.on('entry', (entry) => {
        zipfile.openReadStream(entry, (openErr, stream) => {
          if (openErr) return reject(openErr);
          const chunks = [];
          stream.on('data', (c) => chunks.push(c));
          stream.on('end', () => {
            entries[entry.fileName] = Buffer.concat(chunks);
            zipfile.readEntry();
          });
        });
      });
      zipfile.on('end', () => resolve(entries));
      zipfile.on('error', reject);
      zipfile.readEntry();
    });
  });
}
