import type { Writable } from 'node:stream';
import type { Archiver, ArchiverOptions } from 'archiver';
import type { S3Client, S3ClientConfig, _Object } from '@aws-sdk/client-s3';
import type { CompleteMultipartUploadCommandOutput } from '@aws-sdk/client-s3';

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
  tmpDir?: string;
  logger?: Logger;
}

export type S3File = _Object & { Key: string };

export interface ListParams {
  /** Folder inside the bucket. Use "" for the bucket root. */
  folderName: string;
  /** Resume listing after this key. */
  startKey?: string;
  maxFileCount?: number;
  /** Max total bytes (pre-compression) per batch. */
  maxFileSize?: number;
  recursive?: boolean;
}

export interface ScanStats {
  totalFilesScanned: number;
  lastScannedFile?: S3File;
}

export interface GetFilesResult extends ScanStats {
  files: S3File[];
}

export interface StreamParams extends ListParams {
  pipe?: Writable;
  archiverOptions?: ArchiverOptions;
}

export interface StreamResult {
  zip: Archiver & { manifest: S3File[] };
  zippedFiles: S3File[];
  totalFilesScanned: number;
  lastScannedFile?: S3File;
}

export interface ZipToFileParams {
  s3FolderName: string;
  zipFileName: string;
  startKey?: string;
  maxFileCount?: number;
  maxFileSize?: number;
  recursive?: boolean;
  archiverOptions?: ArchiverOptions;
}

export interface ZipToFileResult extends StreamResult {
  zipFileName: string;
}

export interface ZipToFileFragmentsParams extends ZipToFileParams {
  onFragment?: (result: ZipToFileResult, index: number) => void | Promise<void>;
}

export interface ZipToS3FileParams {
  s3FolderName: string;
  /** Key for the zip. Without a "/" it is placed inside s3FolderName. */
  s3ZipFileName: string;
  startKey?: string;
  maxFileCount?: number;
  maxFileSize?: number;
  recursive?: boolean;
  tmpDir?: string;
  archiverOptions?: ArchiverOptions;
}

export interface ZipToS3FileResult {
  zipFileETag: string | null;
  zipFileLocation: string | null;
  zipFileKey?: string;
  zippedFiles: S3File[];
}

export interface ZipToS3FragmentResult extends ZipToFileResult {
  uploadedFile: CompleteMultipartUploadCommandOutput;
  s3Key: string;
}

export interface ZipToS3FileFragmentsParams extends ZipToS3FileParams {
  onFragment?: (result: ZipToS3FragmentResult, index: number) => void | Promise<void>;
}

declare class S3Zipper {
  constructor(options: S3ZipperOptions);

  bucket: string;
  logger: Logger;
  concurrency: number;
  pageSize: number;
  tmpDir: string;
  s3: S3Client;

  /** Override to exclude objects; return a falsy value to skip. */
  filterOutFiles(file: S3File): S3File | null | undefined | false;
  /** Override to control the entry name inside the zip. */
  calculateFileName(file: S3File, context: { prefix: string; folderName: string }): string;

  /** Lazily yields objects that pass filterOutFiles; `stats` is updated as the scan proceeds. */
  scanFiles(params: ListParams, stats?: ScanStats): AsyncGenerator<S3File, void, undefined>;
  getFiles(params: ListParams): Promise<GetFilesResult>;
  streamZipDataTo(params: StreamParams): Promise<StreamResult>;
  zipToFile(params: ZipToFileParams): Promise<ZipToFileResult>;
  zipToFileFragments(params: ZipToFileFragmentsParams): Promise<ZipToFileResult[]>;
  uploadLocalFileToS3(
    localFileName: string,
    s3Key: string,
    options?: { contentType?: string },
  ): Promise<CompleteMultipartUploadCommandOutput>;
  zipToS3File(params: ZipToS3FileParams): Promise<ZipToS3FileResult>;
  zipToS3FileFragments(params: ZipToS3FileFragmentsParams): Promise<ZipToS3FragmentResult[]>;
}

export { S3Zipper };
export default S3Zipper;
export = S3Zipper;
