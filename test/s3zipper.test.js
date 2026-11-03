'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { S3Client } = require('@aws-sdk/client-s3');
const S3Zipper = require('..');
const { fakeBucket, collector, readZip } = require('./helpers');

const SAMPLE = {
  'photos/': '',
  'photos/a.txt': 'alpha',
  'photos/b.txt': 'bravo',
  'photos/c.tmp': 'skip me',
  'photos/nested/d.txt': 'delta',
  'other/e.txt': 'echo',
  'root.txt': 'root',
};

function makeZipper(objects = SAMPLE, extra = {}) {
  const bucket = fakeBucket(objects);
  const zipper = new S3Zipper({ bucket: 'test-bucket', s3Client: bucket.s3, ...extra });
  return { zipper, ...bucket };
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 's3zipper-test-'));
}

test('constructor', async (t) => {
  await t.test('requires a bucket', () => {
    assert.throws(() => new S3Zipper({}), /bucket/);
    assert.throws(() => new S3Zipper(), /options/);
  });

  await t.test('works without explicit credentials (SDK credential chain)', () => {
    const zipper = new S3Zipper({ bucket: 'b', region: 'us-west-2' });
    assert.ok(zipper.s3 instanceof S3Client);
  });

  await t.test('rejects half-specified static credentials', () => {
    assert.throws(() => new S3Zipper({ bucket: 'b', accessKeyId: 'x' }), /together/);
  });

  await t.test('passes endpoint, path style and session token to the client', async () => {
    const zipper = new S3Zipper({
      bucket: 'b',
      region: 'us-east-1',
      endpoint: 'http://localhost:9000',
      forcePathStyle: true,
      accessKeyId: 'AKIA',
      secretAccessKey: 'secret',
      sessionToken: 'token',
    });
    assert.equal(zipper.s3.config.forcePathStyle, true);
    const endpoint = await zipper.s3.config.endpoint();
    assert.equal(endpoint.hostname, 'localhost');
    const creds = await zipper.s3.config.credentials();
    assert.equal(creds.sessionToken, 'token');
  });
});

test('getFiles', async (t) => {
  await t.test('lists only top-level files when not recursive', async () => {
    const { zipper } = makeZipper();
    const result = await zipper.getFiles({ prefix: 'photos' });
    assert.deepEqual(
      result.files.map((f) => f.Key),
      ['photos/', 'photos/a.txt', 'photos/b.txt', 'photos/c.tmp'],
    );
    assert.equal(result.totalFilesScanned, 4);
    assert.equal(result.lastScannedFile.Key, 'photos/c.tmp');
  });

  await t.test('includes nested keys when recursive', async () => {
    const { zipper } = makeZipper();
    const result = await zipper.getFiles({ prefix: 'photos', recursive: true });
    assert.ok(result.files.some((f) => f.Key === 'photos/nested/d.txt'));
  });

  await t.test('supports the bucket root', async () => {
    const { zipper } = makeZipper();
    const result = await zipper.getFiles({ prefix: '' });
    assert.deepEqual(result.files.map((f) => f.Key), ['root.txt']);
  });

  await t.test('applies filterOutFiles but still counts scanned files', async () => {
    const { zipper } = makeZipper();
    zipper.filterOutFiles = (f) => (f.Key.endsWith('.tmp') ? null : f);
    const result = await zipper.getFiles({ prefix: 'photos' });
    assert.ok(!result.files.some((f) => f.Key.endsWith('.tmp')));
    assert.equal(result.totalFilesScanned, 4);
  });

  await t.test('resumes after startKey', async () => {
    const { zipper } = makeZipper();
    const result = await zipper.getFiles({ prefix: 'photos', startKey: 'photos/a.txt' });
    assert.deepEqual(result.files.map((f) => f.Key), ['photos/b.txt', 'photos/c.tmp']);
  });

  await t.test('caps by maxFileCount across pages', async () => {
    const { zipper } = makeZipper();
    const result = await zipper.getFiles({ prefix: 'photos', maxFileCount: 2 });
    assert.equal(result.files.length, 2);
    assert.equal(result.totalFilesScanned, 2);
    assert.equal(result.lastScannedFile.Key, 'photos/a.txt');
  });

  await t.test('splits by maxFileSize and zips an oversized first file alone', async () => {
    const { zipper } = makeZipper({ 'f/big.bin': 'x'.repeat(100), 'f/small.bin': 'y' });
    const first = await zipper.getFiles({ prefix: 'f', maxFileSize: 10 });
    assert.deepEqual(first.files.map((f) => f.Key), ['f/big.bin']);
    assert.equal(first.lastScannedFile.Key, 'f/big.bin');

    const second = await zipper.getFiles({ prefix: 'f', maxFileSize: 10, startKey: first.lastScannedFile.Key });
    assert.deepEqual(second.files.map((f) => f.Key), ['f/small.bin']);
  });

  await t.test('does not request further pages once a batch is cut off', async () => {
    const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`f/${String(i).padStart(2, '0')}`, 'xxxx']));
    const { zipper, mock } = makeZipper(many);
    const { ListObjectsV2Command } = require('@aws-sdk/client-s3');
    // Force small pages so the scan has to paginate.
    const original = mock.commandCalls(ListObjectsV2Command);
    assert.equal(original.length, 0);
    zipper.pageSize = 5;
    const result = await zipper.getFiles({ prefix: 'f', maxFileSize: 10 });
    assert.deepEqual(result.files.map((f) => f.Key), ['f/00', 'f/01']);
    assert.equal(mock.commandCalls(ListObjectsV2Command).length, 1);
  });

  await t.test('scanFiles yields lazily and updates stats', async () => {
    const { zipper } = makeZipper();
    const stats = { totalFilesScanned: 0, lastScannedFile: undefined };
    const seen = [];
    for await (const f of zipper.scanFiles({ prefix: 'photos', recursive: true }, stats)) {
      seen.push(f.Key);
      if (seen.length === 2) break;
    }
    assert.deepEqual(seen, ['photos/', 'photos/a.txt']);
    assert.equal(stats.totalFilesScanned, 2);
    assert.equal(stats.lastScannedFile.Key, 'photos/a.txt');
  });

  await t.test('stops a batch before an oversized non-first file', async () => {
    const { zipper } = makeZipper({ 'f/a.bin': 'a', 'f/big.bin': 'x'.repeat(100) });
    const result = await zipper.getFiles({ prefix: 'f', maxFileSize: 10 });
    assert.deepEqual(result.files.map((f) => f.Key), ['f/a.bin']);
    assert.equal(result.lastScannedFile.Key, 'f/a.bin');
  });
});

test('streamZipDataTo', async (t) => {
  await t.test('requires prefix', async () => {
    const { zipper } = makeZipper();
    await assert.rejects(zipper.streamZipDataTo({}), /prefix/);
  });

  await t.test('writes a valid zip to the pipe with folder-relative names', async () => {
    const { zipper } = makeZipper();
    const out = collector();
    const result = await zipper.streamZipDataTo({ pipe: out, prefix: 'photos', recursive: true });

    const entries = await readZip(out.buffer());
    assert.deepEqual(entries, {
      'a.txt': 'alpha',
      'b.txt': 'bravo',
      'c.tmp': 'skip me',
      'nested/d.txt': 'delta',
    });
    assert.equal(result.zippedFiles.length, 4);
    assert.equal(result.totalFilesScanned, 5);
    assert.deepEqual(result.zip.manifest, result.zippedFiles);
  });

  await t.test('skips folder placeholder objects', async () => {
    const { zipper } = makeZipper();
    const out = collector();
    const result = await zipper.streamZipDataTo({ pipe: out, prefix: 'photos' });
    assert.ok(!result.zippedFiles.some((f) => f.Key === 'photos/'));
  });

  await t.test('honours a custom calculateFileName', async () => {
    const { zipper } = makeZipper();
    zipper.calculateFileName = (f) => path.basename(f.Key);
    const out = collector();
    await zipper.streamZipDataTo({ pipe: out, prefix: 'photos', recursive: true });
    const entries = await readZip(out.buffer());
    assert.deepEqual(Object.keys(entries).sort(), ['a.txt', 'b.txt', 'c.tmp', 'd.txt']);
  });

  await t.test('rejects when an object cannot be fetched', async () => {
    const { zipper, mock } = makeZipper();
    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    mock.on(GetObjectCommand).rejects(new Error('boom'));
    const out = collector();
    await assert.rejects(zipper.streamZipDataTo({ pipe: out, prefix: 'photos' }), /boom/);
  });

  await t.test('keeps at most `concurrency` object bodies open while zipping', async () => {
    const { zipper, mock } = makeZipper(SAMPLE, { concurrency: 2 });
    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    const { Readable } = require('node:stream');
    let open = 0;
    let peak = 0;
    mock.on(GetObjectCommand).callsFake((input) => {
      open += 1;
      peak = Math.max(peak, open);
      const body = new Readable({
        read() {
          // Deliver slowly so several bodies would overlap if fetched eagerly.
          setTimeout(() => {
            this.push(Buffer.from(SAMPLE[input.Key]));
            this.push(null);
          }, 5);
        },
      });
      body.once('end', () => { open -= 1; });
      return { Body: body };
    });
    const out = collector();
    await zipper.streamZipDataTo({ pipe: out, prefix: 'photos', recursive: true });
    assert.ok(peak <= 2, `peak open bodies was ${peak}`);
    const entries = await readZip(out.buffer());
    assert.equal(Object.keys(entries).length, 4);
  });

  await t.test('respects the concurrency setting', async () => {
    const { zipper, mock } = makeZipper(SAMPLE, { concurrency: 2 });
    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    const { Readable } = require('node:stream');
    let inFlight = 0;
    let peak = 0;
    mock.on(GetObjectCommand).callsFake(async (input) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return { Body: Readable.from([Buffer.from(SAMPLE[input.Key])]) };
    });
    await zipper.streamZipDataTo({ pipe: collector(), prefix: 'photos', recursive: true });
    assert.ok(peak <= 2, `peak concurrency was ${peak}`);
  });
});

test('zipToFile', async (t) => {
  await t.test('writes a zip file and resolves after close', async () => {
    const { zipper } = makeZipper();
    const dir = tmpDir();
    const zipFileName = path.join(dir, 'out.zip');

    const result = await zipper.zipToFile({ prefix: 'photos', zipFileName });
    assert.equal(result.filePath, zipFileName);
    const entries = await readZip(fs.readFileSync(zipFileName));
    assert.deepEqual(Object.keys(entries).sort(), ['a.txt', 'b.txt', 'c.tmp']);
  });

  await t.test('rejects when the file cannot be written', async () => {
    const { zipper } = makeZipper();
    await assert.rejects(
      zipper.zipToFile({ prefix: 'photos', filePath: '/nonexistent-dir/x/out.zip' }),
      /ENOENT/,
    );
  });
});

test('zipToFileFragments', async (t) => {
  await t.test('splits by maxFileCount and names fragments with an index', async () => {
    const { zipper } = makeZipper();
    const dir = tmpDir();
    const seen = [];

    const results = await zipper.zipToFileFragments({
      prefix: 'photos',
      filePath: path.join(dir, 'frag.zip'),
      maxFileCount: 2,
      recursive: true,
      onFragment: (r, i) => seen.push([i, path.basename(r.filePath)]),
    });

    const names = results.map((r) => path.basename(r.filePath));
    assert.deepEqual(names, ['frag_1.zip', 'frag_2.zip', 'frag_3.zip']);
    assert.deepEqual(seen, [[0, 'frag_1.zip'], [1, 'frag_2.zip'], [2, 'frag_3.zip']]);
    assert.deepEqual(results.map((r) => r.zippedFiles.map((f) => f.Key)), [
      ['photos/a.txt'],
      ['photos/b.txt', 'photos/c.tmp'],
      ['photos/nested/d.txt'],
    ]);
    assert.deepEqual(fs.readdirSync(dir).sort(), names, 'no stray files');

    const all = {};
    for (const r of results) Object.assign(all, await readZip(fs.readFileSync(r.filePath)));
    assert.deepEqual(Object.keys(all).sort(), ['a.txt', 'b.txt', 'c.tmp', 'nested/d.txt']);
  });

  await t.test('empty fragments do not consume a number', async () => {
    const { zipper } = makeZipper({ 'f/': '', 'f/x.txt': 'x' });
    const dir = tmpDir();
    const results = await zipper.zipToFileFragments({
      prefix: 'f',
      filePath: path.join(dir, 'frag.zip'),
      maxFileCount: 1,
    });
    assert.deepEqual(results.map((r) => path.basename(r.filePath)), ['frag_1.zip']);
    assert.deepEqual(fs.readdirSync(dir), ['frag_1.zip']);
  });

  await t.test('splits by maxFileSize', async () => {
    const { zipper } = makeZipper({ 'f/1': 'aaaa', 'f/2': 'bbbb', 'f/3': 'cccc' });
    const dir = tmpDir();
    const results = await zipper.zipToFileFragments({
      prefix: 'f',
      filePath: path.join(dir, 'frag'),
      maxFileSize: 8,
    });
    assert.equal(results.length, 2);
    assert.deepEqual(results[0].zippedFiles.map((f) => f.Key), ['f/1', 'f/2']);
    assert.deepEqual(results[1].zippedFiles.map((f) => f.Key), ['f/3']);
  });

  await t.test('returns an empty array for an empty folder', async () => {
    const { zipper } = makeZipper();
    const results = await zipper.zipToFileFragments({
      prefix: 'nothing-here',
      filePath: path.join(tmpDir(), 'frag.zip'),
    });
    assert.deepEqual(results, []);
  });
});

test('zipToS3File', async (t) => {
  await t.test('uploads the zip inside the folder when no path is given', async () => {
    const { zipper, uploads } = makeZipper();
    const result = await zipper.zipToS3File({ prefix: 'photos', key: 'all.zip' });

    assert.equal(uploads.length, 1);
    assert.equal(uploads[0].Key, 'photos/all.zip');
    assert.equal(uploads[0].ContentType, 'application/zip');
    assert.equal(result.key, 'photos/all.zip');
    assert.equal(result.etag, '"etag-1"');
    assert.equal(result.zippedFiles.length, 3);

    const entries = await readZip(uploads[0].body);
    assert.deepEqual(Object.keys(entries).sort(), ['a.txt', 'b.txt', 'c.tmp']);
  });

  await t.test('streams without touching the filesystem', async () => {
    const { zipper, uploads } = makeZipper();
    const openSync = fs.openSync;
    const createWriteStream = fs.createWriteStream;
    let fsWrites = 0;
    fs.openSync = (...a) => { fsWrites += 1; return openSync(...a); };
    fs.createWriteStream = (...a) => { fsWrites += 1; return createWriteStream(...a); };
    try {
      await zipper.zipToS3File({ prefix: 'photos', key: 'all.zip', recursive: true });
    } finally {
      fs.openSync = openSync;
      fs.createWriteStream = createWriteStream;
    }
    assert.equal(fsWrites, 0);
    assert.equal(uploads.length, 1);
  });

  await t.test('rejects and stops when the upload fails', async () => {
    const { zipper, mock } = makeZipper();
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    mock.on(PutObjectCommand).rejects(new Error('upload exploded'));
    await assert.rejects(
      zipper.zipToS3File({ prefix: 'photos', key: 'all.zip' }),
      /upload exploded/,
    );
  });

  await t.test('uses the full key when a path is given', async () => {
    const { zipper, uploads } = makeZipper();
    await zipper.zipToS3File({ prefix: 'photos', key: 'archive/x.zip' });
    assert.equal(uploads[0].Key, 'archive/x.zip');
  });

  await t.test('skips the upload when nothing was zipped', async () => {
    const { zipper, uploads } = makeZipper();
    const result = await zipper.zipToS3File({ prefix: 'empty', key: 'x.zip' });
    assert.equal(uploads.length, 0);
    assert.deepEqual(result, {
      key: null,
      etag: null,
      location: null,
      zippedFiles: [],
      totalFilesScanned: 0,
      lastScannedFile: undefined,
    });
  });
});

test('zipToS3FileFragments', async (t) => {
  await t.test('uploads each fragment with an index suffix and cleans up', async () => {
    const { zipper, uploads } = makeZipper();
    const results = await zipper.zipToS3FileFragments({
      prefix: 'photos',
      key: 'frag.zip',
      maxFileCount: 2,
      recursive: true,
    });

    const expected = ['photos/frag_1.zip', 'photos/frag_2.zip', 'photos/frag_3.zip'];
    assert.deepEqual(uploads.map((u) => u.Key), expected);
    assert.deepEqual(results.map((r) => r.key), expected);
    assert.ok(results.every((r) => r.etag));
    assert.deepEqual(results.map((r) => r.zippedFiles.length), [1, 2, 1]);
  });
});

test('legacy 1.x parameter names are accepted as aliases', async () => {
  const { zipper, uploads } = makeZipper();
  const dir = tmpDir();
  const local = await zipper.zipToFile({ s3FolderName: 'photos', zipFileName: path.join(dir, 'a.zip') });
  assert.equal(local.filePath, path.join(dir, 'a.zip'));
  assert.equal(local.zippedFiles.length, 3);

  const out = collector();
  const streamed = await zipper.streamZipDataTo({ pipe: out, folderName: 'photos' });
  assert.equal(streamed.zippedFiles.length, 3);

  const remote = await zipper.zipToS3File({ s3FolderName: 'photos', s3ZipFileName: 'b.zip' });
  assert.equal(remote.key, 'photos/b.zip');
  assert.equal(uploads[0].Key, 'photos/b.zip');

  // Canonical name wins when both are given.
  const listed = await zipper.getFiles({ prefix: 'other', folderName: 'photos' });
  assert.deepEqual(listed.files.map((f) => f.Key), ['other/e.txt']);
});

test('uploadLocalFileToS3 uploads an existing file', async () => {
  const { zipper, uploads } = makeZipper();
  const file = path.join(tmpDir(), 'x.zip');
  fs.writeFileSync(file, 'zipbytes');
  const result = await zipper.uploadLocalFileToS3(file, 'dest/x.zip');
  assert.equal(result.ETag, '"etag-1"');
  assert.equal(uploads[0].Key, 'dest/x.zip');
  assert.equal(uploads[0].body.toString(), 'zipbytes');
});

test('streamZipDataTo with createPipe never creates the pipe for an empty folder', async () => {
  const { zipper } = makeZipper();
  let created = 0;
  const result = await zipper.streamZipDataTo({
    prefix: 'nothing',
    createPipe: () => { created += 1; return collector(); },
  });
  assert.equal(created, 0);
  assert.deepEqual(result.zippedFiles, []);
});

test('AbortSignal', async (t) => {
  await t.test('an already-aborted signal rejects before any request', async () => {
    const { zipper, mock } = makeZipper();
    const { ListObjectsV2Command } = require('@aws-sdk/client-s3');
    const signal = AbortSignal.abort();
    await assert.rejects(zipper.zipToFile({ prefix: 'photos', filePath: path.join(tmpDir(), 'x.zip'), signal }), { name: 'AbortError' });
    await assert.rejects(zipper.zipToS3File({ prefix: 'photos', key: 'x.zip', signal }), { name: 'AbortError' });
    await assert.rejects(zipper.getFiles({ prefix: 'photos', signal }), { name: 'AbortError' });
    assert.equal(mock.commandCalls(ListObjectsV2Command).length, 0);
  });

  await t.test('aborting mid-stream stops fetching and rejects', async () => {
    const { zipper, mock } = makeZipper(SAMPLE, { concurrency: 1 });
    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    const { Readable } = require('node:stream');
    const controller = new AbortController();
    let fetches = 0;
    mock.on(GetObjectCommand).callsFake(async (input) => {
      fetches += 1;
      if (fetches === 2) controller.abort();
      return { Body: Readable.from([Buffer.from(SAMPLE[input.Key])]) };
    });
    const out = collector();
    await assert.rejects(
      zipper.streamZipDataTo({ pipe: out, prefix: 'photos', recursive: true, signal: controller.signal }),
      { name: 'AbortError' },
    );
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(fetches <= 3, `kept fetching after abort: ${fetches}`);
  });

  await t.test('uses signal.reason when provided', async () => {
    const { zipper } = makeZipper();
    const signal = AbortSignal.abort(new Error('custom reason'));
    await assert.rejects(zipper.getFiles({ prefix: 'photos', signal }), /custom reason/);
  });

  await t.test('aborting during the upload rejects zipToS3File', async () => {
    const { zipper, mock } = makeZipper();
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    const controller = new AbortController();
    mock.on(PutObjectCommand).callsFake(async () => {
      controller.abort();
      await new Promise((r) => setTimeout(r, 50));
      return { ETag: '"late"' };
    });
    await assert.rejects(
      zipper.zipToS3File({ prefix: 'photos', key: 'x.zip', signal: controller.signal }),
      { name: 'AbortError' },
    );
  });

  await t.test('fragment loops stop between fragments', async () => {
    const { zipper } = makeZipper();
    const controller = new AbortController();
    const dir = tmpDir();
    await assert.rejects(
      zipper.zipToFileFragments({
        prefix: 'photos',
        filePath: path.join(dir, 'f.zip'),
        maxFileCount: 2,
        recursive: true,
        signal: controller.signal,
        onFragment: () => controller.abort(),
      }),
      { name: 'AbortError' },
    );
    assert.deepEqual(fs.readdirSync(dir), ['f_1.zip']);
  });
});

test('logger receives progress messages', async () => {
  const messages = [];
  const logger = {
    debug: (...a) => messages.push(['debug', ...a]),
    info: (...a) => messages.push(['info', ...a]),
    warn: (...a) => messages.push(['warn', ...a]),
    error: (...a) => messages.push(['error', ...a]),
  };
  const { zipper } = makeZipper(SAMPLE, { logger });
  await zipper.zipToS3File({ prefix: 'photos', key: 'x.zip' });
  assert.ok(messages.some(([level, msg]) => level === 'debug' && msg === 'zipping'));
  assert.ok(messages.some(([level, msg]) => level === 'info' && msg === 'upload completed'));
});
