import type { Writable } from 'node:stream';
import type { Archiver, ArchiverOptions } from 'archiver';
import type { S3Client, S3ClientConfig, _Object } from '@aws-sdk/client-s3';
import type { CompleteMultipartUploadCommandOutput } from '@aws-sdk/client-s3';
import type { Options as UploadOptions } from '@aws-sdk/lib-storage';

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface S3ZipperOptions {
  bucket: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  endpoint?: string;
  forcePathStyle?: boolean;
  /** @deprecated use forcePathStyle */
  s3ForcePathStyle?: boolean;
  clientConfig?: S3ClientConfig;
  s3Client?: S3Client;
  concurrency?: number;
  /** Objects per ListObjectsV2 page (1-1000). */
  pageSize?: number;
  /** Extra options for @aws-sdk/lib-storage Upload (partSize, queueSize, tags, ...). */
  uploadOptions?: Omit<UploadOptions, 'client' | 'params'>;
  logger?: Logger;
}

export type S3File = _Object & { Key: string };

export interface ListParams {
  /** Prefix ("folder") inside the bucket. Use "" for the whole bucket. */
  prefix: string;
  /** Resume listing after this key. */
  startKey?: string;
  maxFileCount?: number;
  /** Max total bytes (pre-compression) per batch. */
  maxFileSize?: number;
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

export interface StreamResult {
  zip: Archiver & { manifest: S3File[] };
  zippedFiles: S3File[];
  totalFilesScanned: number;
  lastScannedFile?: S3File;
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

declare class S3Zipper {
  constructor(options: S3ZipperOptions);

  bucket: string;
  logger: Logger;
  concurrency: number;
  pageSize: number;
  uploadOptions: Omit<UploadOptions, 'client' | 'params'>;
  s3: S3Client;

  /** Override to exclude objects; return a falsy value to skip. */
  filterOutFiles(file: S3File): S3File | null | undefined | false;
  /** Override to control the entry name inside the zip. */
  calculateFileName(file: S3File, context: { prefix: string }): string;

  /** Lazily yields objects that pass filterOutFiles; `stats` is updated as the scan proceeds. */
  scanFiles(params: ListParams, stats?: ScanStats): AsyncGenerator<S3File, void, undefined>;
  getFiles(params: ListParams): Promise<GetFilesResult>;
  streamZipDataTo(params: StreamParams): Promise<StreamResult>;
  zipToFile(params: ZipToFileParams): Promise<ZipToFileResult>;
  zipToFileFragments(params: ZipToFileFragmentsParams): Promise<ZipToFileResult[]>;
  uploadLocalFileToS3(
    localFileName: string,
    key: string,
    options?: { contentType?: string; signal?: AbortSignal },
  ): Promise<CompleteMultipartUploadCommandOutput>;
  zipToS3File(params: ZipToS3FileParams): Promise<ZipToS3FileResult>;
  zipToS3FileFragments(params: ZipToS3FileFragmentsParams): Promise<ZipToS3FileResult[]>;
}

export { S3Zipper };
export default S3Zipper;
export = S3Zipper;
