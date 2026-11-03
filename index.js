'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { once } = require('node:events');
const archiver = require('archiver');
const {
  S3Client,
  GetObjectCommand,
  paginateListObjectsV2,
} = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');

const noopLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

/**
 * Build the S3Client configuration from the user-facing options.
 * Credentials are optional: when omitted the SDK's default provider chain
 * (env vars, shared credentials file, IAM role, etc.) is used.
 */
function buildClientConfig(options) {
  const config = { ...(options.clientConfig || {}) };

  if (options.region) config.region = options.region;
  if (options.endpoint) config.endpoint = options.endpoint;
  if (options.forcePathStyle ?? options.s3ForcePathStyle) config.forcePathStyle = true;

  if (options.accessKeyId || options.secretAccessKey) {
    if (!options.accessKeyId || !options.secretAccessKey) {
      throw new TypeError('S3Zipper: accessKeyId and secretAccessKey must be provided together');
    }
    config.credentials = {
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
      ...(options.sessionToken ? { sessionToken: options.sessionToken } : {}),
    };
  }

  return config;
}

/** Normalise a folder name into an S3 key prefix ('' for the bucket root). */
function toPrefix(folderName) {
  const trimmed = String(folderName ?? '').replace(/^\/+|\/+$/g, '');
  return trimmed ? `${trimmed}/` : '';
}

function fragmentName(fileName, index) {
  const ext = path.extname(fileName);
  const base = ext ? fileName.slice(0, -ext.length) : fileName;
  return `${base}_${index}${ext || '.zip'}`;
}

function ensureZipExtension(fileName) {
  return fileName.toLowerCase().endsWith('.zip') ? fileName : `${fileName}.zip`;
}

class S3Zipper {
  /**
   * @param {object} options
   * @param {string} options.bucket            S3 bucket name (required).
   * @param {string} [options.region]
   * @param {string} [options.accessKeyId]     Optional. Defaults to the SDK credential chain.
   * @param {string} [options.secretAccessKey]
   * @param {string} [options.sessionToken]
   * @param {string} [options.endpoint]        For S3-compatible services (MinIO, Spaces, ...).
   * @param {boolean} [options.forcePathStyle]
   * @param {object} [options.clientConfig]    Extra S3Client config, merged in.
   * @param {S3Client} [options.s3Client]      Bring your own client (also used for testing).
   * @param {number} [options.concurrency=10]  Parallel GetObject requests while zipping.
   * @param {number} [options.pageSize=1000]   Objects per ListObjectsV2 page (max 1000).
   * @param {string} [options.tmpDir]          Where temp zips are written. Defaults to os.tmpdir().
   * @param {object} [options.logger]          Object with debug/info/warn/error. Silent by default.
   */
  constructor(options) {
    if (!options || typeof options !== 'object') {
      throw new TypeError('S3Zipper: options object is required');
    }
    if (!options.bucket) {
      throw new TypeError('S3Zipper: "bucket" is required');
    }

    this.bucket = options.bucket;
    this.logger = options.logger || noopLogger;
    this.concurrency = Math.max(1, options.concurrency ?? 10);
    this.pageSize = Math.min(1000, Math.max(1, options.pageSize ?? 1000));
    this.tmpDir = options.tmpDir || os.tmpdir();
    this.s3 = options.s3Client || new S3Client(buildClientConfig(options));
  }

  /**
   * Override to exclude objects. Return a falsy value to skip the object.
   * @param {object} file  S3 object record ({ Key, Size, ETag, LastModified, ... }).
   */
  filterOutFiles(file) {
    return file;
  }

  /**
   * Override to control the entry name inside the zip.
   * Default: the key relative to the zipped folder (an empty string marks a
   * folder placeholder object and is skipped).
   */
  calculateFileName(file, { prefix }) {
    return file.Key.startsWith(prefix) ? file.Key.slice(prefix.length) : file.Key;
  }

  /**
   * Lazily scan objects under a folder, page by page, applying
   * filterOutFiles and the maxFileCount / maxFileSize batching rules.
   * Yields only objects that passed the filter. `stats` is updated as the
   * scan progresses so the consumer can report totalFilesScanned and
   * lastScannedFile without the generator having to buffer anything.
   *
   * @param {object} params
   * @param {{totalFilesScanned: number, lastScannedFile?: object}} stats
   */
  async *scanFiles(params = {}, stats = { totalFilesScanned: 0, lastScannedFile: undefined }) {
    const { startKey, maxFileCount, maxFileSize, recursive = false } = params;
    const prefix = toPrefix(params.folderName);

    const input = { Bucket: this.bucket, Prefix: prefix };
    if (startKey) input.StartAfter = startKey;
    if (!recursive) input.Delimiter = '/';
    const pageSize = maxFileCount > 0 ? Math.min(maxFileCount, this.pageSize) : this.pageSize;
    if (pageSize < 1000) input.MaxKeys = pageSize;

    let passedCount = 0;
    let totalSize = 0;

    for await (const page of paginateListObjectsV2({ client: this.s3 }, input)) {
      for (const file of page.Contents || []) {
        if (maxFileCount > 0 && stats.totalFilesScanned >= maxFileCount) return;
        stats.totalFilesScanned += 1;

        const passed = this.filterOutFiles(file);
        if (passed) {
          if (maxFileSize && passed.Size > maxFileSize) {
            this.logger.warn('Single file exceeds maxFileSize', { key: passed.Key, size: passed.Size, maxFileSize });
            if (passedCount > 0) {
              // Leave the oversized object for the next batch, where it is zipped alone.
              stats.totalFilesScanned -= 1;
              return;
            }
            this.logger.warn('Zipping oversized file on its own', { key: passed.Key });
          } else if (maxFileSize && totalSize + passed.Size > maxFileSize) {
            this.logger.debug('Hit maxFileSize, splitting fragment', { totalSize, maxFileSize });
            stats.totalFilesScanned -= 1;
            return;
          }
          passedCount += 1;
          totalSize += passed.Size;
          stats.lastScannedFile = file;
          yield passed;
        } else {
          stats.lastScannedFile = file;
        }
      }
    }
  }

  /**
   * List objects under a folder, applying filterOutFiles and the
   * maxFileCount / maxFileSize batching rules. Convenience wrapper around
   * scanFiles that collects the batch into an array.
   *
   * @returns {Promise<{files: object[], totalFilesScanned: number, lastScannedFile: object|undefined}>}
   */
  async getFiles(params = {}) {
    const stats = { totalFilesScanned: 0, lastScannedFile: undefined };
    const files = [];
    for await (const file of this.scanFiles(params, stats)) files.push(file);
    return { files, ...stats };
  }

  /**
   * Stream a zip of the folder into `params.pipe` (any Writable, e.g. an HTTP
   * response). Resolves once the archive has been fully written to the pipe.
   *
   * @returns {Promise<{zip: import('archiver').Archiver, zippedFiles: object[], totalFilesScanned: number, lastScannedFile: object|undefined}>}
   */
  async streamZipDataTo(params) {
    if (!params || params.folderName === undefined) {
      throw new TypeError('S3Zipper.streamZipDataTo: "folderName" is required (use "" for the bucket root)');
    }

    const prefix = toPrefix(params.folderName);
    const stats = { totalFilesScanned: 0, lastScannedFile: undefined };

    const archive = archiver('zip', params.archiverOptions);
    const failure = new Promise((_, reject) => archive.once('error', reject));
    archive.on('warning', (warning) => this.logger.warn('archiver warning', warning));

    if (params.pipe) {
      archive.pipe(params.pipe);
      // If the consumer goes away (e.g. HTTP client disconnects) stop pulling
      // objects from S3 instead of buffering them in memory.
      params.pipe.once('close', () => {
        if (!archive._state?.finalized) archive.abort();
      });
    }

    const zippedFiles = [];

    const fetchEntry = async (file) => {
      if (file.Key.endsWith('/')) return { file, name: null, body: null }; // folder placeholder
      const name = this.calculateFileName(file, { prefix, folderName: params.folderName });
      if (!name) return { file, name: null, body: null };
      const { Body } = await this.s3.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: file.Key }),
      );
      return { file, name, body: Body };
    };

    const appendBatch = async (batch) => {
      for (const { file, name, body } of await Promise.all(batch)) {
        if (!name) continue;
        this.logger.debug('zipping', { key: file.Key, name });
        archive.append(body, { name, date: file.LastModified });
        zippedFiles.push(file);
      }
    };

    const work = (async () => {
      let batch = [];
      for await (const file of this.scanFiles(params, stats)) {
        batch.push(fetchEntry(file));
        if (batch.length >= this.concurrency) {
          await appendBatch(batch);
          batch = [];
        }
      }
      await appendBatch(batch);
      await archive.finalize();
    })();

    await Promise.race([work, failure]);

    const zip = archive;
    zip.manifest = zippedFiles;
    return {
      zip,
      zippedFiles,
      totalFilesScanned: stats.totalFilesScanned,
      lastScannedFile: stats.lastScannedFile,
    };
  }

  /**
   * Zip a folder to a local file. Resolves after the file handle is closed.
   */
  async zipToFile(params) {
    if (!params?.zipFileName) {
      throw new TypeError('S3Zipper.zipToFile: "zipFileName" is required');
    }
    const fileStream = fs.createWriteStream(params.zipFileName);
    const closed = once(fileStream, 'close');
    const streamError = new Promise((_, reject) => fileStream.once('error', reject));
    // Both settle on 'error'; whichever is not currently awaited must not surface as unhandled.
    closed.catch(() => {});
    streamError.catch(() => {});

    try {
      const result = await Promise.race([
        this.streamZipDataTo({
          pipe: fileStream,
          folderName: params.s3FolderName,
          startKey: params.startKey,
          maxFileCount: params.maxFileCount,
          maxFileSize: params.maxFileSize,
          recursive: params.recursive,
          archiverOptions: params.archiverOptions,
        }),
        streamError,
      ]);
      await Promise.race([closed, streamError]);
      return { ...result, zipFileName: params.zipFileName };
    } catch (err) {
      fileStream.destroy();
      throw err;
    }
  }

  /**
   * Zip a folder into multiple local zip files, split by maxFileCount and/or
   * maxFileSize. Fragments are numbered from 1 with `_<n>` appended before the
   * extension (`out_1.zip`, `out_2.zip`, ...). Empty fragments are discarded
   * and do not consume a number.
   * `params.onFragment(result, index)` is awaited after each fragment is written
   * (index is zero-based).
   *
   * @returns {Promise<object[]>} one result per non-empty fragment.
   */
  async zipToFileFragments(params) {
    if (!params?.zipFileName) {
      throw new TypeError('S3Zipper.zipToFileFragments: "zipFileName" is required');
    }
    if (params.maxFileSize && params.maxFileSize < 1024) {
      this.logger.warn('maxFileSize is very low; fragments may be empty', { maxFileSize: params.maxFileSize });
    }

    const baseName = ensureZipExtension(params.zipFileName);
    const results = [];
    let startKey = params.startKey;

    for (;;) {
      const fragFileName = fragmentName(baseName, results.length + 1);
      const result = await this.zipToFile({ ...params, startKey, zipFileName: fragFileName });

      if (result.zippedFiles.length > 0) {
        results.push(result);
        if (params.onFragment) await params.onFragment(result, results.length - 1);
      } else {
        await fs.promises.rm(fragFileName, { force: true });
      }

      if (result.totalFilesScanned === 0 || !result.lastScannedFile) break;
      startKey = result.lastScannedFile.Key;
    }

    return results;
  }

  /**
   * Upload a local file to S3 with multipart support.
   */
  async uploadLocalFileToS3(localFileName, s3Key, { contentType = 'application/zip' } = {}) {
    this.logger.info('uploading', { key: s3Key });
    const body = fs.createReadStream(localFileName);
    const upload = new Upload({
      client: this.s3,
      params: { Bucket: this.bucket, Key: s3Key, ContentType: contentType, Body: body },
    });

    let lastReported = -1;
    upload.on('httpUploadProgress', (progress) => {
      if (!progress.total) return;
      const pct = Math.floor((progress.loaded / progress.total) * 10) * 10;
      if (pct > lastReported) {
        lastReported = pct;
        this.logger.info('upload progress', { key: s3Key, percent: pct });
      }
    });

    try {
      const result = await upload.done();
      this.logger.info('upload completed', { key: s3Key });
      return result;
    } finally {
      body.destroy();
    }
  }

  /**
   * Zip a folder and upload the zip back to S3. When s3ZipFileName has no
   * path it is placed inside s3FolderName.
   */
  async zipToS3File(params) {
    if (!params?.s3ZipFileName) {
      throw new TypeError('S3Zipper.zipToS3File: "s3ZipFileName" is required');
    }
    const s3Key = this._resolveS3ZipKey(params);
    const tmpFile = this._tempZipPath(params.tmpDir);

    try {
      const result = await this.zipToFile({ ...params, zipFileName: tmpFile });
      if (result.zippedFiles.length === 0) {
        this.logger.info('no files zipped, nothing to upload');
        return { zipFileETag: null, zipFileLocation: null, zippedFiles: [] };
      }
      const upload = await this.uploadLocalFileToS3(tmpFile, s3Key);
      return {
        zipFileETag: upload.ETag ?? null,
        zipFileLocation: upload.Location ?? null,
        zipFileKey: s3Key,
        zippedFiles: result.zippedFiles,
      };
    } finally {
      await fs.promises.rm(tmpFile, { force: true });
    }
  }

  /**
   * Zip a folder into fragments and upload each fragment to S3.
   * Uploaded keys are numbered from 1 with `_<n>` appended before the extension.
   *
   * @returns {Promise<object[]>} fragment results, each with `uploadedFile`.
   */
  async zipToS3FileFragments(params) {
    if (!params?.s3ZipFileName) {
      throw new TypeError('S3Zipper.zipToS3FileFragments: "s3ZipFileName" is required');
    }
    const s3Key = ensureZipExtension(this._resolveS3ZipKey(params));
    const tmpBase = this._tempZipPath(params.tmpDir);

    return this.zipToFileFragments({
      ...params,
      zipFileName: tmpBase,
      onFragment: async (result, index) => {
        const fragKey = fragmentName(s3Key, index + 1);
        try {
          result.uploadedFile = await this.uploadLocalFileToS3(result.zipFileName, fragKey);
          result.s3Key = fragKey;
        } finally {
          await fs.promises.rm(result.zipFileName, { force: true });
        }
        if (params.onFragment) await params.onFragment(result, index);
      },
    });
  }

  _resolveS3ZipKey(params) {
    return params.s3ZipFileName.includes('/')
      ? params.s3ZipFileName
      : `${toPrefix(params.s3FolderName)}${params.s3ZipFileName}`;
  }

  _tempZipPath(tmpDir) {
    return path.join(tmpDir || this.tmpDir, `aws-s3-zipper-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.zip`);
  }
}

module.exports = S3Zipper;
module.exports.S3Zipper = S3Zipper;
module.exports.default = S3Zipper;
