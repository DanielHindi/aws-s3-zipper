# Amazon S3 Zipping tool (aws-s3-zipper)

Zip the contents of an S3 "folder" to a stream, a local file, local file fragments, an S3 object, or S3 object fragments. Built on AWS SDK v3 and [archiver](https://www.npmjs.com/package/archiver). Objects are streamed from S3 straight into the zip, so memory use stays flat regardless of file size.

Requires Node.js 20 or newer. Upgrading from 1.x? See [Migrating from 1.x](#migrating-from-1x).

## What does it do?

1. **Zips S3 files** to a stream, a local file, local file fragments, an S3 file, or S3 file fragments.
2. **Differential zipping**: save the key of the last file you zipped and only zip files added after it.
3. **Fragmented zips**: cap each zip by file count or total (pre-compression) byte size.
4. **Filtering**: skip objects based on any criteria.

## Install

```bash
npm install aws-s3-zipper
```

## Setup

```js
const S3Zipper = require('aws-s3-zipper');

const zipper = new S3Zipper({
  bucket: 'my-bucket',
  region: 'us-west-2',
});
```

Credentials are optional. When omitted the AWS SDK default credential chain is used (environment variables, `~/.aws/credentials`, IAM roles on EC2/ECS/Lambda, SSO, etc.). All options:

| Option | Description |
| --- | --- |
| `bucket` | **Required.** Bucket name. |
| `region` | AWS region. Falls back to the SDK's region resolution. |
| `accessKeyId`, `secretAccessKey` | Static credentials. Must be given together. |
| `sessionToken` | For temporary credentials. |
| `endpoint` | Custom endpoint for S3-compatible services (MinIO, DigitalOcean Spaces, ...). |
| `forcePathStyle` | Use path-style URLs. Usually needed with a custom endpoint. |
| `clientConfig` | Any extra `S3ClientConfig` merged into the client. |
| `s3Client` | Bring your own `S3Client` instance (the options above are then ignored). |
| `concurrency` | Parallel `GetObject` requests while zipping. Default `10`. |
| `pageSize` | Objects per listing page, 1 to 1000. Default `1000`. |
| `uploadOptions` | Extra options for the multipart `Upload` (`partSize`, `queueSize`, `tags`, ...). |
| `logger` | Object with `debug`, `info`, `warn`, `error`. Silent by default. Pass `console` to see progress. |

### Filter out files

```js
zipper.filterOutFiles = (file) => (file.Key.endsWith('.tmp') ? null : file);
```

### Control entry names

By default entries are named relative to the zipped folder (`photos/2024/a.jpg` → `2024/a.jpg`). Override to flatten or rename:

```js
const path = require('node:path');
zipper.calculateFileName = (file) => path.basename(file.Key);
```

## Usage

Every method returns a Promise.

### Zip to a local file

```js
const result = await zipper.zipToFile({
  s3FolderName: 'photos',
  zipFileName: './photos.zip',
  startKey: lastKeyFromPreviousRun, // optional
  recursive: true,
});

const last = result.zippedFiles.at(-1);
if (last) console.log('next time start after', last.Key);
```

### Pipe a zip to a stream (Express example)

```js
app.get('/download', async (req, res, next) => {
  res.set('Content-Type', 'application/zip');
  res.set('Content-Disposition', 'attachment; filename="photos.zip"');
  try {
    await zipper.streamZipDataTo({ pipe: res, folderName: 'photos', recursive: true });
  } catch (err) {
    next(err);
  }
});
```

If the client disconnects the archive is aborted and no further objects are fetched.

### Cancelling

```js
const controller = new AbortController();
setTimeout(() => controller.abort(), 30_000);
await zipper.zipToS3File({ s3FolderName: 'photos', s3ZipFileName: 'photos.zip', signal: controller.signal });
```

### Zip to local fragments

```js
const results = await zipper.zipToFileFragments({
  s3FolderName: 'photos',
  zipFileName: './photos.zip', // produces photos_1.zip, photos_2.zip, ...
  maxFileCount: 500,
  maxFileSize: 500 * 1024 * 1024,
  recursive: true,
  onFragment: (fragment, index) => console.log('wrote', fragment.zipFileName),
});
```

### Zip to an S3 object

```js
const result = await zipper.zipToS3File({
  s3FolderName: 'photos',
  s3ZipFileName: 'photos.zip', // no "/" → stored as photos/photos.zip
  recursive: true,
});
console.log(result.zipFileKey, result.zipFileETag);
```

### Zip to S3 fragments

```js
const results = await zipper.zipToS3FileFragments({
  s3FolderName: 'photos',
  s3ZipFileName: 'archives/photos.zip', // uploads archives/photos_1.zip, archives/photos_2.zip, ...
  maxFileCount: 500,
});
```

### Zip the bucket root

Pass an empty string as the folder name:

```js
await zipper.zipToFile({ s3FolderName: '', zipFileName: './bucket.zip', recursive: true });
```

## API

All list-style methods accept these common params:

| Param | Description |
| --- | --- |
| `folderName` / `s3FolderName` | Folder inside the bucket. `''` for the root. |
| `startKey` | Only include objects whose key sorts after this one. |
| `maxFileCount` | Stop scanning after this many objects. |
| `maxFileSize` | Max total bytes (pre-compression) per batch. An object larger than this is zipped alone if it is first in the batch, otherwise the batch ends before it. |
| `recursive` | Include nested "folders". Default `false`. |
| `archiverOptions` | Passed to `archiver('zip', options)` (e.g. `{ zlib: { level: 9 } }`). |
| `signal` | An `AbortSignal`. Aborting cancels listing, object fetches, archiving and any in-progress upload, and the call rejects with `signal.reason` (an `AbortError` by default). |

### `scanFiles(params, stats?)` → `AsyncGenerator<file>`

Lazily yields objects that pass `filterOutFiles`, page by page, stopping at the batch cut-off. `stats` (`{ totalFilesScanned, lastScannedFile }`) is updated as the scan proceeds.

### `getFiles(params)` → `{ files, totalFilesScanned, lastScannedFile }`

Collects `scanFiles` into an array. `totalFilesScanned` counts filtered-out objects too; `lastScannedFile` is where the next batch should resume.

### `streamZipDataTo(params)` → `{ zip, zippedFiles, totalFilesScanned, lastScannedFile }`

Writes a zip into `params.pipe` (any Writable). Resolves once the archive has finished. `zip` is the archiver instance with a `manifest` property equal to `zippedFiles`. Pass `createPipe` instead of `pipe` to create the destination lazily; it is only called when the first entry is written, so an empty folder writes nothing.

### `zipToFile(params)` → `{ ..., zipFileName }`

As above, into a local file. Resolves after the file handle is closed.

### `zipToFileFragments(params)` → `result[]`

Repeats `zipToFile` from `lastScannedFile` until the folder is exhausted. Fragments are named `name_1.zip`, `name_2.zip`, ... Empty fragments are deleted and do not consume a number. `params.onFragment(result, index)` is awaited after each fragment.

### `zipToS3File(params)` → `{ zipFileKey, zipFileETag, zipFileLocation, zippedFiles }`

Streams the archive straight into a multipart upload; nothing touches the local disk, so it works on Lambda and other read-only filesystems. If `s3ZipFileName` has no `/` it is placed inside `s3FolderName`. When the folder yields no entries nothing is uploaded and `zipFileKey` is `null`. The result also carries `totalFilesScanned` and `lastScannedFile`.

### `zipToS3FileFragments(params)` → `result[]`

Fragments streamed and uploaded as `key_1.zip`, `key_2.zip`, ... Each result has the same shape as `zipToS3File`.

### `uploadLocalFileToS3(localFileName, s3Key, { contentType })`

Multipart upload helper for an existing local file.

## TypeScript

Type definitions ship with the package (`index.d.ts`).

```ts
import S3Zipper from 'aws-s3-zipper';
```

## Migrating from 1.x

Version 2 is a rewrite. Breaking changes:

- **Node 20+** is required.
- **Promises instead of callbacks.** Every method returns a Promise; the trailing callback argument is gone.
- **No positional arguments.** Pass a params object to every method.
- **AWS SDK v3.** `aws-sdk` and `@auth0/s3` are no longer dependencies. `accessKeyId`/`secretAccessKey`/`region` are now optional. `s3ForcePathStyle` is accepted as an alias of `forcePathStyle`.
- **Silent by default.** Pass `logger: console` to get the old progress output.
- **No temp files.** The S3 methods stream directly into a multipart upload. The `tmpDir` param is gone.
- **Fragment naming** is consistent and 1-based for both local and S3 fragments (`name_1.zip`, `name_2.zip`, ...). Previously the first local fragment had no suffix and S3 fragments were 0-based.
- `zipToFileFragments` no longer returns an `events` object; use `params.onFragment` instead.
- Fragment methods reject on the first error instead of collecting errors.
- `calculateFileName(file, { prefix, folderName })` receives a context argument. The default implementation strips the folder prefix (same result as before for non-root folders).
- `init()` was removed. Construct a new instance instead.

## License

MIT
