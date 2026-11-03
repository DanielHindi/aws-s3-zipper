import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { PassThrough, type Readable, type Writable } from 'node:stream';
import archiver, { type Archiver, type ArchiverOptions } from 'archiver';
import {
  S3Client,
  GetObjectCommand,
  ListObjectsV2Command,
  type S3ClientConfig,
  type ListObjectsV2CommandInput,
  type ListObjectsV2CommandOutput,
  type CompleteMultipartUploadCommandOutput,
  type _Object,
} from '@aws-sdk/client-s3';
import { Upload, type Options as UploadOptions } from '@aws-sdk/lib-storage';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface S3ZipperOptions {
  /** Bucket name. */
  bucket: string;
  region?: string;
  /** Static credentials. Optional: the SDK default credential chain is used otherwise. */
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  /** Custom endpoint for S3-compatible services. */
  endpoint?: string;
  forcePathStyle?: boolean;
  /** @deprecated use forcePathStyle */
  s3ForcePathStyle?: boolean;
  /** Extra S3Client config merged into the client. */
  clientConfig?: S3ClientConfig;
  /** Bring your own client; the connection options above are then ignored. */
  s3Client?: S3Client;
  /** Max GetObject requests in flight while zipping. Default 10. */
  concurrency?: number;
  /** Objects per ListObjectsV2 page (1-1000). Default 1000. */
  pageSize?: number;
  /** Extra options for @aws-sdk/lib-storage Upload (partSize, queueSize, tags, ...). */
  uploadOptions?: Omit<UploadOptions, 'client' | 'params'>;
  /** Silent by default. Pass `console` to see progress. */
  logger?: Logger;
}

export type S3File = _Object & { Key: string };

export interface ListParams {
  /** Prefix ("folder") inside the bucket. Use "" for the whole bucket. */
  prefix: string;
  /** Only include objects whose key sorts after this one. */
  startKey?: string;
  /** Stop scanning after this many objects. */
  maxFileCount?: number;
  /** Max total bytes (pre-compression) per batch. */
  maxFileSize?: number;
  /** Include nested "folders". Default false. */
  recursive?: boolean;
  /** Cancels listing, object fetches, archiving and uploads. */
  signal?: AbortSignal;
}

export interface ScanStats {
  totalFilesScanned: number;
  lastScannedFile?: S3File;
}

export interface GetFilesResult extends ScanStats {
  files: S3File[];
}

export interface StreamParams extends ListParams {
  /** Destination stream, attached immediately. */
  pipe?: Writable;
  /** Lazily created destination; only called when the first entry is written. */
  createPipe?: () => Writable | Promise<Writable>;
  archiverOptions?: ArchiverOptions;
}

export interface StreamResult extends ScanStats {
  zip: Archiver & { manifest: S3File[] };
  zippedFiles: S3File[];
}

export interface ZipToFileParams extends ListParams {
  /** Local path of the zip to write. */
  filePath: string;
  archiverOptions?: ArchiverOptions;
}

export interface ZipToFileResult extends StreamResult {
  filePath: string;
}

export interface ZipToFileFragmentsParams extends ZipToFileParams {
  onFragment?: (result: ZipToFileResult, index: number) => void | Promise<void>;
}

export interface ZipToS3FileParams extends ListParams {
  /** Key for the zip. Without a "/" it is placed inside `prefix`. */
  key: string;
  contentType?: string;
  archiverOptions?: ArchiverOptions;
}

export interface ZipToS3FileResult extends ScanStats {
  /** null when nothing was zipped and therefore nothing uploaded. */
  key: string | null;
  etag: string | null;
  location: string | null;
  zippedFiles: S3File[];
}

export interface ZipToS3FileFragmentsParams extends ZipToS3FileParams {
  onFragment?: (result: ZipToS3FileResult, index: number) => void | Promise<void>;
}

export interface UploadFileOptions {
  contentType?: string;
  signal?: AbortSignal;
}

/** The 1.x parameter names, still accepted as aliases. */
export interface LegacyParamAliases {
  /** @deprecated use prefix */
  folderName?: string;
  /** @deprecated use prefix */
  s3FolderName?: string;
  /** @deprecated use filePath */
  zipFileName?: string;
  /** @deprecated use key */
  s3ZipFileName?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const noopLogger: Logger = {
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
function buildClientConfig(options: S3ZipperOptions): S3ClientConfig {
  const config: S3ClientConfig = { ...(options.clientConfig ?? {}) };

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
function toPrefix(folderName: string | undefined | null): string {
  const trimmed = String(folderName ?? '').replace(/^\/+|\/+$/g, '');
  return trimmed ? `${trimmed}/` : '';
}

function fragmentName(fileName: string, index: number): string {
  const ext = path.extname(fileName);
  const base = ext ? fileName.slice(0, -ext.length) : fileName;
  return `${base}_${index}${ext || '.zip'}`;
}

function ensureZipExtension(fileName: string): string {
  return fileName.toLowerCase().endsWith('.zip') ? fileName : `${fileName}.zip`;
}

const LEGACY_PARAM_NAMES: Record<keyof LegacyParamAliases, 'prefix' | 'filePath' | 'key'> = {
  folderName: 'prefix',
  s3FolderName: 'prefix',
  zipFileName: 'filePath',
  s3ZipFileName: 'key',
};

/**
 * Accept the 1.x parameter names as aliases of the flat 2.x names.
 * Returns a shallow copy with only the canonical names set.
 */
function normalizeParams<T extends object>(params: T): T {
  if (!params || typeof params !== 'object') return params;
  const out: Record<string, unknown> = { ...(params as Record<string, unknown>) };
  for (const [legacy, canonical] of Object.entries(LEGACY_PARAM_NAMES)) {
    if (legacy in out) {
      if (out[canonical] === undefined) out[canonical] = out[legacy];
      delete out[legacy];
    }
  }
  return out as T;
}

/** The error to reject with when `signal` has been aborted. */
function abortReason(signal: AbortSignal | undefined): unknown {
  return signal?.reason ?? new DOMException('The operation was aborted', 'AbortError');
}

interface FetchedEntry {
  file: S3File;
  name: string | null;
  body: Readable | null;
}

// ---------------------------------------------------------------------------
// S3Zipper
// ---------------------------------------------------------------------------

export class S3Zipper {
  readonly bucket: string;
  logger: Logger;
  concurrency: number;
  pageSize: number;
  uploadOptions: Omit<UploadOptions, 'client' | 'params'>;
  readonly s3: S3Client;

  constructor(options: S3ZipperOptions) {
    if (!options || typeof options !== 'object') {
      throw new TypeError('S3Zipper: options object is required');
    }
    if (!options.bucket) {
      throw new TypeError('S3Zipper: "bucket" is required');
    }

    this.bucket = options.bucket;
    this.logger = options.logger ?? noopLogger;
    this.concurrency = Math.max(1, options.concurrency ?? 10);
    this.pageSize = Math.min(1000, Math.max(1, options.pageSize ?? 1000));
    this.uploadOptions = options.uploadOptions ?? {};
    this.s3 = options.s3Client ?? new S3Client(buildClientConfig(options));
  }

  /**
   * Override to exclude objects. Return a falsy value to skip the object.
   */
  filterOutFiles(file: S3File): S3File | null | undefined | false {
    return file;
  }

  /**
   * Override to control the entry name inside the zip.
   * Default: the key relative to the zipped prefix. Return an empty string
   * to skip the object.
   */
  calculateFileName(file: S3File, { prefix }: { prefix: string }): string {
    return file.Key.startsWith(prefix) ? file.Key.slice(prefix.length) : file.Key;
  }

  /**
   * Lazily scan objects under a prefix, page by page, applying
   * filterOutFiles and the maxFileCount / maxFileSize batching rules.
   * Yields only objects that passed the filter. `stats` is updated as the
   * scan progresses so the consumer can report totalFilesScanned and
   * lastScannedFile without the generator having to buffer anything.
   */
  async *scanFiles(
    params: ListParams,
    stats: ScanStats = { totalFilesScanned: 0, lastScannedFile: undefined },
  ): AsyncGenerator<S3File, void, undefined> {
    params = normalizeParams(params);
    const { startKey, maxFileCount = 0, maxFileSize = 0, recursive = false, signal } = params;
    const prefix = toPrefix(params.prefix);

    const input: ListObjectsV2CommandInput = { Bucket: this.bucket, Prefix: prefix };
    if (startKey) input.StartAfter = startKey;
    if (!recursive) input.Delimiter = '/';
    const pageSize = maxFileCount > 0 ? Math.min(maxFileCount, this.pageSize) : this.pageSize;
    if (pageSize < 1000) input.MaxKeys = pageSize;

    let passedCount = 0;
    let totalSize = 0;

    for await (const page of this.pages(input, signal)) {
      for (const file of (page.Contents ?? []) as S3File[]) {
        if (maxFileCount > 0 && stats.totalFilesScanned >= maxFileCount) return;
        stats.totalFilesScanned += 1;

        const passed = this.filterOutFiles(file);
        if (passed) {
          const size = passed.Size ?? 0;
          if (maxFileSize && size > maxFileSize) {
            this.logger.warn('Single file exceeds maxFileSize', { key: passed.Key, size, maxFileSize });
            if (passedCount > 0) {
              // Leave the oversized object for the next batch, where it is zipped alone.
              stats.totalFilesScanned -= 1;
              return;
            }
            this.logger.warn('Zipping oversized file on its own', { key: passed.Key });
          } else if (maxFileSize && totalSize + size > maxFileSize) {
            this.logger.debug('Hit maxFileSize, splitting fragment', { totalSize, maxFileSize });
            stats.totalFilesScanned -= 1;
            return;
          }
          passedCount += 1;
          totalSize += size;
          stats.lastScannedFile = file;
          yield passed;
        } else {
          stats.lastScannedFile = file;
        }
      }
    }
  }

  /**
   * List objects under a prefix, applying filterOutFiles and the
   * maxFileCount / maxFileSize batching rules. Convenience wrapper around
   * scanFiles that collects the batch into an array.
   */
  async getFiles(params: ListParams): Promise<GetFilesResult> {
    const stats: ScanStats = { totalFilesScanned: 0, lastScannedFile: undefined };
    const files: S3File[] = [];
    for await (const file of this.scanFiles(params, stats)) files.push(file);
    return { files, ...stats };
  }

  /**
   * Stream a zip of the prefix into `params.pipe` (any Writable, e.g. an HTTP
   * response). Resolves once the archive has been fully written to the pipe.
   *
   * Alternatively pass `params.createPipe`, a function returning a Writable
   * that is only invoked when the first entry is about to be written. If the
   * prefix yields no entries the function is never called and nothing is
   * written anywhere.
   */
  async streamZipDataTo(params: StreamParams): Promise<StreamResult> {
    params = normalizeParams(params);
    if (!params || params.prefix === undefined) {
      throw new TypeError('S3Zipper.streamZipDataTo: "prefix" is required (use "" for the bucket root)');
    }
    if (params.pipe && params.createPipe) {
      throw new TypeError('S3Zipper.streamZipDataTo: pass either "pipe" or "createPipe", not both');
    }

    const { signal } = params;
    signal?.throwIfAborted();

    const prefix = toPrefix(params.prefix);
    const stats: ScanStats = { totalFilesScanned: 0, lastScannedFile: undefined };

    const archive = archiver('zip', params.archiverOptions) as Archiver & {
      manifest: S3File[];
      _state?: { finalized?: boolean };
    };
    archive.on('warning', (warning) => this.logger.warn('archiver warning', warning));

    let failed!: (err: unknown) => void;
    const failure = new Promise<never>((_, reject) => {
      failed = (err: unknown) => {
        if (!archive._state?.finalized) archive.abort();
        reject(err);
      };
      archive.once('error', failed);
    });
    const onAbort = () => failed(abortReason(signal));
    signal?.addEventListener('abort', onAbort, { once: true });

    let pipe: Writable | null = null;
    const attach = (dest: Writable) => {
      pipe = dest;
      archive.pipe(dest);
      dest.once('error', failed);
      // If the consumer goes away (e.g. HTTP client disconnects) stop pulling
      // objects from S3 instead of buffering them in memory.
      dest.once('close', () => {
        if (!archive._state?.finalized) {
          failed(
            Object.assign(new Error('Destination closed before the archive was finished'), {
              code: 'ERR_DESTINATION_CLOSED',
            }),
          );
        }
      });
    };
    if (params.pipe) attach(params.pipe);

    const zippedFiles: S3File[] = [];

    const fetchEntry = async (file: S3File): Promise<FetchedEntry> => {
      if (file.Key.endsWith('/')) return { file, name: null, body: null }; // folder placeholder
      const name = this.calculateFileName(file, { prefix });
      if (!name) return { file, name: null, body: null };
      const { Body } = await this.s3.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: file.Key }),
        { abortSignal: signal },
      );
      return { file, name, body: Body as unknown as Readable };
    };

    // Sliding window: at most `concurrency` GetObject responses are open at
    // once, and the next object is only fetched after archiver has finished
    // consuming the oldest one. Memory therefore stays bounded by
    // `concurrency` in-flight streams rather than a whole batch of bodies.
    const inFlight: Promise<FetchedEntry>[] = [];

    const drainOne = async () => {
      const { file, name, body } = await inFlight.shift()!;
      if (!name || !body) return;
      if (!pipe && params.createPipe) attach(await params.createPipe());
      this.logger.debug('zipping', { key: file.Key, name });
      const entryDone = once(archive, 'entry');
      archive.append(body, { name, date: file.LastModified });
      zippedFiles.push(file);
      await entryDone;
    };

    const work = (async () => {
      try {
        for await (const file of this.scanFiles(params, stats)) {
          inFlight.push(fetchEntry(file));
          if (inFlight.length >= this.concurrency) await drainOne();
        }
        while (inFlight.length > 0) await drainOne();

        if (!pipe && params.createPipe) {
          // Nothing was appended, so no destination was ever created.
          archive.abort();
          return;
        }
        await archive.finalize();
      } catch (err) {
        // Release any responses we never got to append.
        for (const pending of inFlight) {
          pending.then(({ body }) => body?.destroy?.(), () => {});
        }
        throw err;
      }
    })();
    work.catch(() => {});

    try {
      await Promise.race([work, failure]);
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }

    archive.manifest = zippedFiles;
    return {
      zip: archive,
      zippedFiles,
      totalFilesScanned: stats.totalFilesScanned,
      lastScannedFile: stats.lastScannedFile,
    };
  }

  /**
   * Zip a prefix to a local file. Resolves after the file handle is closed.
   */
  async zipToFile(params: ZipToFileParams): Promise<ZipToFileResult> {
    params = normalizeParams(params);
    if (!params?.filePath) {
      throw new TypeError('S3Zipper.zipToFile: "filePath" is required');
    }
    const fileStream = fs.createWriteStream(params.filePath);
    const closed = once(fileStream, 'close');
    closed.catch(() => {});

    try {
      const result = await this.streamZipDataTo({ ...this.listParams(params), pipe: fileStream });
      await closed;
      return { ...result, filePath: params.filePath };
    } catch (err) {
      fileStream.destroy();
      throw err;
    }
  }

  /**
   * Zip a prefix into multiple local zip files, split by maxFileCount and/or
   * maxFileSize. Fragments are numbered from 1 with `_<n>` appended before the
   * extension (`out_1.zip`, `out_2.zip`, ...). Empty fragments are discarded
   * and do not consume a number.
   * `params.onFragment(result, index)` is awaited after each fragment is written
   * (index is zero-based).
   */
  async zipToFileFragments(params: ZipToFileFragmentsParams): Promise<ZipToFileResult[]> {
    params = normalizeParams(params);
    if (!params?.filePath) {
      throw new TypeError('S3Zipper.zipToFileFragments: "filePath" is required');
    }
    this.warnLowMaxFileSize(params);
    const baseName = ensureZipExtension(params.filePath);

    return this.fragmentLoop(params, async (startKey, number) => {
      const filePath = fragmentName(baseName, number);
      const result = await this.zipToFile({ ...params, startKey, filePath });
      if (result.zippedFiles.length === 0) await fs.promises.rm(filePath, { force: true });
      return result;
    });
  }

  /**
   * Zip a prefix and upload the zip to S3 as a multipart upload, streaming
   * straight from the archiver with no temporary file. When `key` has no
   * path it is placed inside `prefix`. If the prefix yields no entries
   * nothing is uploaded.
   */
  async zipToS3File(params: ZipToS3FileParams): Promise<ZipToS3FileResult> {
    params = normalizeParams(params);
    if (!params?.key) {
      throw new TypeError('S3Zipper.zipToS3File: "key" is required');
    }
    const s3Key = this.resolveS3ZipKey(params);

    let uploadDone: Promise<CompleteMultipartUploadCommandOutput> | null = null;
    const result = await this.streamZipDataTo({
      ...this.listParams(params),
      createPipe: () => {
        const pass = new PassThrough();
        uploadDone = this.startUpload(pass, s3Key, params.contentType, params.signal);
        // If the upload fails, tear down the pipe so the archive stops.
        uploadDone.catch((err: Error) => pass.destroy(err));
        return pass;
      },
    });

    if (!uploadDone) {
      this.logger.info('no files zipped, nothing to upload', { key: s3Key });
      return {
        key: null,
        etag: null,
        location: null,
        zippedFiles: [],
        totalFilesScanned: result.totalFilesScanned,
        lastScannedFile: result.lastScannedFile,
      };
    }

    const upload: CompleteMultipartUploadCommandOutput = await uploadDone;
    this.logger.info('upload completed', { key: s3Key });
    return {
      key: s3Key,
      etag: upload.ETag ?? null,
      location: upload.Location ?? null,
      zippedFiles: result.zippedFiles,
      totalFilesScanned: result.totalFilesScanned,
      lastScannedFile: result.lastScannedFile,
    };
  }

  /**
   * Zip a prefix into fragments and upload each one to S3, streaming.
   * Uploaded keys are numbered from 1 with `_<n>` appended before the extension.
   */
  async zipToS3FileFragments(params: ZipToS3FileFragmentsParams): Promise<ZipToS3FileResult[]> {
    params = normalizeParams(params);
    if (!params?.key) {
      throw new TypeError('S3Zipper.zipToS3FileFragments: "key" is required');
    }
    this.warnLowMaxFileSize(params);
    const baseKey = ensureZipExtension(this.resolveS3ZipKey(params));

    return this.fragmentLoop(params, (startKey, number) =>
      this.zipToS3File({ ...params, startKey, key: fragmentName(baseKey, number) }),
    );
  }

  /**
   * Upload a local file to S3 with multipart support.
   */
  async uploadLocalFileToS3(
    localFileName: string,
    key: string,
    { contentType = 'application/zip', signal }: UploadFileOptions = {},
  ): Promise<CompleteMultipartUploadCommandOutput> {
    signal?.throwIfAborted();
    const body = fs.createReadStream(localFileName);
    try {
      const result = await this.startUpload(body, key, contentType, signal);
      this.logger.info('upload completed', { key });
      return result;
    } finally {
      body.destroy();
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Start a multipart upload of `body` and return its completion promise.
   * Progress is logged once per 10% when the total size is known.
   */
  private startUpload(
    body: Readable,
    key: string,
    contentType = 'application/zip',
    signal?: AbortSignal,
  ): Promise<CompleteMultipartUploadCommandOutput> {
    this.logger.info('uploading', { key });
    const abortController = new AbortController();
    const upload = new Upload({
      client: this.s3,
      ...this.uploadOptions,
      abortController,
      params: { Bucket: this.bucket, Key: key, ContentType: contentType, Body: body },
    });

    let lastReported = -1;
    upload.on('httpUploadProgress', (progress) => {
      if (progress.total && progress.loaded !== undefined) {
        const pct = Math.floor((progress.loaded / progress.total) * 10) * 10;
        if (pct > lastReported) {
          lastReported = pct;
          this.logger.info('upload progress', { key, percent: pct });
        }
      } else {
        this.logger.debug('upload progress', { key, loaded: progress.loaded, part: progress.part });
      }
    });

    if (!signal) return upload.done();

    const onAbort = () => abortController.abort(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    return upload.done().finally(() => signal.removeEventListener('abort', onAbort));
  }

  /**
   * Shared driver for the fragment methods: run one fragment at a time from
   * `startKey`, keep the non-empty ones, and stop when a pass scans nothing.
   */
  private async fragmentLoop<R extends ScanStats & { zippedFiles: S3File[] }>(
    params: ListParams & { onFragment?: (result: R, index: number) => void | Promise<void> },
    runFragment: (startKey: string | undefined, number: number) => Promise<R>,
  ): Promise<R[]> {
    const results: R[] = [];
    let startKey = params.startKey;

    for (;;) {
      params.signal?.throwIfAborted();
      const result = await runFragment(startKey, results.length + 1);
      if (result.zippedFiles.length > 0) {
        results.push(result);
        if (params.onFragment) await params.onFragment(result, results.length - 1);
      }
      if (result.totalFilesScanned === 0 || !result.lastScannedFile) break;
      startKey = result.lastScannedFile.Key;
    }

    return results;
  }

  /** ListObjectsV2 pagination that honours an AbortSignal. */
  private async *pages(
    input: ListObjectsV2CommandInput,
    signal?: AbortSignal,
  ): AsyncGenerator<ListObjectsV2CommandOutput, void, undefined> {
    let ContinuationToken: string | undefined;
    do {
      signal?.throwIfAborted();
      const page = await this.s3.send(
        new ListObjectsV2Command({ ...input, ContinuationToken }),
        { abortSignal: signal },
      );
      yield page;
      ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (ContinuationToken);
  }

  private listParams(params: ListParams & { archiverOptions?: ArchiverOptions }): StreamParams {
    return {
      prefix: params.prefix,
      startKey: params.startKey,
      maxFileCount: params.maxFileCount,
      maxFileSize: params.maxFileSize,
      recursive: params.recursive,
      archiverOptions: params.archiverOptions,
      signal: params.signal,
    };
  }

  private warnLowMaxFileSize(params: ListParams): void {
    if (params.maxFileSize && params.maxFileSize < 1024) {
      this.logger.warn('maxFileSize is very low; fragments may be empty', { maxFileSize: params.maxFileSize });
    }
  }

  /** A key without a "/" is placed inside the zipped prefix. */
  private resolveS3ZipKey(params: ZipToS3FileParams): string {
    return params.key.includes('/') ? params.key : `${toPrefix(params.prefix)}${params.key}`;
  }
}

export default S3Zipper;
