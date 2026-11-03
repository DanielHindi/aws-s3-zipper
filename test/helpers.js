'use strict';

const { Readable, Writable } = require('node:stream');
const yauzl = require('yauzl');
const { mockClient } = require('aws-sdk-client-mock');
const {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
} = require('@aws-sdk/client-s3');

/**
 * Build a fake bucket: { 'folder/a.txt': 'contents', ... }.
 * Returns a mocked S3Client plus helpers.
 */
function fakeBucket(objects) {
  const keys = Object.keys(objects).sort();
  const records = keys.map((Key) => ({
    Key,
    Size: Buffer.byteLength(objects[Key]),
    ETag: `"${Key}"`,
    LastModified: new Date('2024-01-01T00:00:00Z'),
  }));

  const uploads = [];
  const s3 = new S3Client({ region: 'us-east-1' });
  const mock = mockClient(s3);

  mock.on(ListObjectsV2Command).callsFake((input) => {
    const prefix = input.Prefix || '';
    const pageSize = input.MaxKeys || 1000;
    let matching = records.filter((r) => r.Key.startsWith(prefix));

    if (input.Delimiter) {
      matching = matching.filter((r) => !r.Key.slice(prefix.length).includes(input.Delimiter));
    }

    const after = input.ContinuationToken || input.StartAfter;
    if (after) matching = matching.filter((r) => r.Key > after);

    const page = matching.slice(0, pageSize);
    const truncated = matching.length > pageSize;
    return {
      Contents: page,
      IsTruncated: truncated,
      NextContinuationToken: truncated ? page[page.length - 1].Key : undefined,
    };
  });

  mock.on(GetObjectCommand).callsFake((input) => {
    if (!(input.Key in objects)) {
      const err = new Error('NoSuchKey');
      err.name = 'NoSuchKey';
      throw err;
    }
    return { Body: Readable.from([Buffer.from(objects[input.Key])]) };
  });

  mock.on(PutObjectCommand).callsFake(async (input) => {
    let body = input.Body;
    if (!Buffer.isBuffer(body) && !(body instanceof Uint8Array)) {
      const chunks = [];
      for await (const chunk of body) chunks.push(chunk);
      body = Buffer.concat(chunks);
    }
    uploads.push({ Key: input.Key, ContentType: input.ContentType, body: Buffer.from(body) });
    return { ETag: `"etag-${uploads.length}"` };
  });

  return { s3, mock, uploads, records };
}

/** A Writable that collects everything into a Buffer. */
function collector() {
  const chunks = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk);
      cb();
    },
  });
  stream.buffer = () => Buffer.concat(chunks);
  return stream;
}

/** Read a zip buffer into { entryName: contents }. */
function readZip(buffer) {
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
            entries[entry.fileName] = Buffer.concat(chunks).toString();
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

module.exports = { fakeBucket, collector, readZip };
