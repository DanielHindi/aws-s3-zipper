'use strict';

/**
 * A deliberately small S3-compatible HTTP server for integration tests when
 * no real endpoint (MinIO, S3) is available. It speaks just enough of the S3
 * REST API for the SDK v3 calls this library makes, over real HTTP and XML,
 * so the whole SDK request/response pipeline is exercised:
 *
 *   PUT    /bucket                         create bucket
 *   GET    /bucket?list-type=2             ListObjectsV2 (prefix, delimiter,
 *                                          start-after, continuation-token,
 *                                          max-keys)
 *   GET    /bucket/key                     GetObject
 *   PUT    /bucket/key                     PutObject
 *   PUT    /bucket/key?partNumber&uploadId UploadPart
 *   POST   /bucket/key?uploads             CreateMultipartUpload
 *   POST   /bucket/key?uploadId            CompleteMultipartUpload
 *   DELETE /bucket/key?uploadId            AbortMultipartUpload
 *   DELETE /bucket/key                     DeleteObject
 *   POST   /bucket?delete                  DeleteObjects
 *
 * Signatures are not verified. Path-style addressing only.
 */

const http = require('node:http');
const crypto = require('node:crypto');

const XMLNS = 'http://s3.amazonaws.com/doc/2006-03-01/';

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function md5(buffer) {
  return crypto.createHash('md5').update(buffer).digest('hex');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(decodeAwsChunked(req, Buffer.concat(chunks))));
    req.on('error', reject);
  });
}

/**
 * The SDK may send streaming bodies as `aws-chunked` with a trailing
 * checksum. Decode that framing back into the raw payload.
 */
function decodeAwsChunked(req, body) {
  const encoding = String(req.headers['content-encoding'] || '');
  if (!encoding.split(',').map((s) => s.trim()).includes('aws-chunked')) return body;

  const out = [];
  let offset = 0;
  for (;;) {
    const lineEnd = body.indexOf('\r\n', offset);
    if (lineEnd === -1) break;
    const header = body.subarray(offset, lineEnd).toString();
    const size = parseInt(header.split(';')[0], 16);
    if (Number.isNaN(size) || size === 0) break;
    const start = lineEnd + 2;
    out.push(body.subarray(start, start + size));
    offset = start + size + 2;
  }
  return Buffer.concat(out);
}

function sendXml(res, status, xml) {
  res.writeHead(status, { 'content-type': 'application/xml' });
  res.end(`<?xml version="1.0" encoding="UTF-8"?>\n${xml}`);
}

function sendError(res, status, code, message) {
  sendXml(res, status, `<Error><Code>${code}</Code><Message>${xmlEscape(message)}</Message></Error>`);
}

class FakeS3Server {
  constructor() {
    this.buckets = new Map(); // bucket -> Map(key -> { body, etag, lastModified })
    this.uploads = new Map(); // uploadId -> { bucket, key, parts: Map(partNumber -> buffer) }
    this.requests = []; // [{ method, path }] for assertions
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        sendError(res, 500, 'InternalError', err.message);
      });
    });
  }

  async listen() {
    await new Promise((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const { port } = this.server.address();
    this.endpoint = `http://127.0.0.1:${port}`;
    return this.endpoint;
  }

  async close() {
    this.server.closeAllConnections?.();
    await new Promise((resolve) => this.server.close(resolve));
  }

  bucket(name) {
    if (!this.buckets.has(name)) this.buckets.set(name, new Map());
    return this.buckets.get(name);
  }

  async handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const [, bucketName, ...rest] = url.pathname.split('/');
    const key = decodeURIComponent(rest.join('/'));
    this.requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams) });

    if (!bucketName) return sendError(res, 400, 'InvalidRequest', 'bucket required');

    if (!key) {
      if (req.method === 'PUT') {
        this.bucket(bucketName);
        res.writeHead(200).end();
        return;
      }
      if (req.method === 'HEAD') {
        res.writeHead(this.buckets.has(bucketName) ? 200 : 404).end();
        return;
      }
      if (req.method === 'GET' && url.searchParams.get('list-type') === '2') {
        return this.listObjectsV2(bucketName, url.searchParams, res);
      }
      if (req.method === 'POST' && url.searchParams.has('delete')) {
        const body = (await readBody(req)).toString();
        const keys = [...body.matchAll(/<Key>([^<]*)<\/Key>/g)].map((m) => m[1]);
        const objects = this.bucket(bucketName);
        for (const k of keys) objects.delete(k);
        return sendXml(res, 200, `<DeleteResult xmlns="${XMLNS}">${keys.map((k) => `<Deleted><Key>${xmlEscape(k)}</Key></Deleted>`).join('')}</DeleteResult>`);
      }
      return sendError(res, 501, 'NotImplemented', `${req.method} ${url.pathname}${url.search}`);
    }

    const objects = this.bucket(bucketName);

    if (req.method === 'POST' && url.searchParams.has('uploads')) {
      const uploadId = crypto.randomBytes(8).toString('hex');
      this.uploads.set(uploadId, { bucket: bucketName, key, parts: new Map() });
      await readBody(req);
      return sendXml(res, 200, `<InitiateMultipartUploadResult xmlns="${XMLNS}"><Bucket>${xmlEscape(bucketName)}</Bucket><Key>${xmlEscape(key)}</Key><UploadId>${uploadId}</UploadId></InitiateMultipartUploadResult>`);
    }

    if (req.method === 'PUT' && url.searchParams.has('uploadId')) {
      const upload = this.uploads.get(url.searchParams.get('uploadId'));
      if (!upload) return sendError(res, 404, 'NoSuchUpload', 'no such upload');
      const partNumber = Number(url.searchParams.get('partNumber'));
      const body = await readBody(req);
      upload.parts.set(partNumber, body);
      res.writeHead(200, { etag: `"${md5(body)}"` }).end();
      return;
    }

    if (req.method === 'POST' && url.searchParams.has('uploadId')) {
      const uploadId = url.searchParams.get('uploadId');
      const upload = this.uploads.get(uploadId);
      if (!upload) return sendError(res, 404, 'NoSuchUpload', 'no such upload');
      await readBody(req);
      const ordered = [...upload.parts.entries()].sort((a, b) => a[0] - b[0]).map(([, buf]) => buf);
      const body = Buffer.concat(ordered);
      const etag = `"${md5(body)}-${ordered.length}"`;
      objects.set(key, { body, etag, lastModified: new Date() });
      this.uploads.delete(uploadId);
      return sendXml(res, 200, `<CompleteMultipartUploadResult xmlns="${XMLNS}"><Location>${xmlEscape(`${this.endpoint}/${bucketName}/${key}`)}</Location><Bucket>${xmlEscape(bucketName)}</Bucket><Key>${xmlEscape(key)}</Key><ETag>${xmlEscape(etag)}</ETag></CompleteMultipartUploadResult>`);
    }

    if (req.method === 'DELETE' && url.searchParams.has('uploadId')) {
      this.uploads.delete(url.searchParams.get('uploadId'));
      res.writeHead(204).end();
      return;
    }

    if (req.method === 'PUT') {
      const body = await readBody(req);
      const etag = `"${md5(body)}"`;
      objects.set(key, { body, etag, lastModified: new Date() });
      res.writeHead(200, { etag }).end();
      return;
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      const obj = objects.get(key);
      if (!obj) return sendError(res, 404, 'NoSuchKey', 'The specified key does not exist.');
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': obj.body.length,
        etag: obj.etag,
        'last-modified': obj.lastModified.toUTCString(),
      });
      res.end(req.method === 'HEAD' ? undefined : obj.body);
      return;
    }

    if (req.method === 'DELETE') {
      objects.delete(key);
      res.writeHead(204).end();
      return;
    }

    return sendError(res, 501, 'NotImplemented', `${req.method} ${url.pathname}${url.search}`);
  }

  listObjectsV2(bucketName, params, res) {
    const objects = this.bucket(bucketName);
    const prefix = params.get('prefix') || '';
    const delimiter = params.get('delimiter') || '';
    const maxKeys = Number(params.get('max-keys') || 1000);
    const after = params.get('continuation-token') || params.get('start-after') || '';

    const keys = [...objects.keys()].filter((k) => k.startsWith(prefix) && k > after).sort();
    const contents = [];
    const commonPrefixes = new Set();
    let truncated = false;
    let lastEmitted;

    for (const k of keys) {
      if (contents.length + commonPrefixes.size >= maxKeys) {
        truncated = true;
        break;
      }
      if (delimiter) {
        const rest = k.slice(prefix.length);
        const idx = rest.indexOf(delimiter);
        if (idx !== -1) {
          commonPrefixes.add(prefix + rest.slice(0, idx + delimiter.length));
          lastEmitted = k;
          continue;
        }
      }
      contents.push(k);
      lastEmitted = k;
    }

    const items = contents.map((k) => {
      const o = objects.get(k);
      return `<Contents><Key>${xmlEscape(k)}</Key><LastModified>${o.lastModified.toISOString()}</LastModified><ETag>${xmlEscape(o.etag)}</ETag><Size>${o.body.length}</Size><StorageClass>STANDARD</StorageClass></Contents>`;
    });
    const cps = [...commonPrefixes].map((p) => `<CommonPrefixes><Prefix>${xmlEscape(p)}</Prefix></CommonPrefixes>`);

    sendXml(
      res,
      200,
      `<ListBucketResult xmlns="${XMLNS}">` +
        `<Name>${xmlEscape(bucketName)}</Name><Prefix>${xmlEscape(prefix)}</Prefix>` +
        (delimiter ? `<Delimiter>${xmlEscape(delimiter)}</Delimiter>` : '') +
        `<KeyCount>${contents.length + commonPrefixes.size}</KeyCount><MaxKeys>${maxKeys}</MaxKeys>` +
        `<IsTruncated>${truncated}</IsTruncated>` +
        (truncated ? `<NextContinuationToken>${xmlEscape(lastEmitted)}</NextContinuationToken>` : '') +
        items.join('') +
        cps.join('') +
        `</ListBucketResult>`,
    );
  }
}

module.exports = { FakeS3Server };
