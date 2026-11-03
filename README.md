# Amazon S3 Zipping tool (aws-s3-zipper)

Zip the objects under an S3 prefix to a stream, a local file, local file fragments, an S3 object, or S3 object fragments. Built on AWS SDK v3 and [archiver](https://www.npmjs.com/package/archiver). Objects are streamed from S3 straight into the zip, and zips destined for S3 are streamed straight into a multipart upload, so neither memory nor disk use grows with the size of the data.

Requires Node.js 20 or newer. Upgrading from 1.x? See [Migrating from 1.x](#migrating-from-1x).

## What does it do?

1. **Zips S3 objects** to a stream, a local file, local file fragments, an S3 object, or S3 object fragments.
2. **Differential zipping**: save the key of the last object you zipped and only zip objects added after it.
3. **Fragmented zips**: cap each zip by object count or total (pre-compression) byte size.
4. **Filtering**: skip objects based on any criteria.
5. **Cancellation** with a standard `AbortSignal`.

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
| `concurrency` | Max `GetObject` requests in flight while zipping. Default `10`. |
| `pageSize` | Objects per listing page, 1 to 1000. Default `1000`. |
| `uploadOptions` | Extra options for the multipart `Upload` (`partSize`, `queueSize`, `tags`, ...). |
| `logger` | Object with `debug`, `info`, `warn`, `error`. Silent by default. Pass `console` to see progress. |

### Filter out objects

```js
zipper.filterOutFiles = (file) => (file.Key.endsWith('.tmp') ? null : file);
```

### Control entry names

By default entries are named relative to the zipped prefix (`photos/2024/a.jpg` under prefix `photos` becomes `2024/a.jpg`). Override to flatten or rename; return an empty string to skip an object:

```js
const path = require('node:path');
zipper.calculateFileName = (file) => path.basename(file.Key);
```

## Usage

Every method returns a Promise and takes a single params object. The same names are used everywhere:

| Param | Description |
| --- | --- |
| `prefix` | Prefix ("folder") inside the bucket. `''` for the whole bucket. |
| `startKey` | Only include objects whose key sorts after this one. |
| `maxFileCount` | Stop scanning after this many objects. |
| `maxFileSize` | Max total bytes (pre-compression) per batch. An object larger than this is zipped alone if it is first in the batch, otherwise the batch ends before it. |
| `recursive` | Include nested "folders". Default `false`. |
| `signal` | An `AbortSignal`. Aborting cancels listing, fetches, archiving and uploads; the call rejects with `signal.reason`. |
| `archiverOptions` | Passed to `archiver('zip', options)` (e.g. `{ zlib: { level: 9 } }`). |

Destinations: `pipe` (a Writable) for streaming, `filePath` for local files, `key` for S3 objects.

### Zip to a local file

```js
const result = await zipper.zipToFile({
  prefix: 'photos',
  filePath: './photos.zip',
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
    await zipper.streamZipDataTo({ pipe: res, prefix: 'photos', recursive: true });
  } catch (err) {
    next(err);
  }
});
```

If the client disconnects the archive is aborted and no further objects are fetched.

### Zip to an S3 object

```js
const result = await zipper.zipToS3File({
  prefix: 'photos',
  key: 'photos.zip', // no "/" → stored as photos/photos.zip
  recursive: true,
});
console.log(result.key, result.etag);
```

### Fragments

```js
// Local: writes photos_1.zip, photos_2.zip, ...
const local = await zipper.zipToFileFragments({
  prefix: 'photos',
  filePath: './photos.zip',
  maxFileCount: 500,
  maxFileSize: 500 * 1024 * 1024,
  recursive: true,
  onFragment: (fragment, index) => console.log('wrote', fragment.filePath),
});

// S3: uploads archives/photos_1.zip, archives/photos_2.zip, ...
const remote = await zipper.zipToS3FileFragments({
  prefix: 'photos',
  key: 'archives/photos.zip',
  maxFileCount: 500,
});
```

### Cancelling

```js
const controller = new AbortController();
setTimeout(() => controller.abort(), 30_000);
await zipper.zipToS3File({ prefix: 'photos', key: 'photos.zip', signal: controller.signal });
```

### Zip the whole bucket

```js
await zipper.zipToFile({ prefix: '', filePath: './bucket.zip', recursive: true });
```

## API

### `scanFiles(params, stats?)` → `AsyncGenerator<file>`

Lazily yields objects that pass `filterOutFiles`, page by page, stopping at the batch cut-off. `stats` (`{ totalFilesScanned, lastScannedFile }`) is updated as the scan proceeds.

### `getFiles(params)` → `{ files, totalFilesScanned, lastScannedFile }`

Collects `scanFiles` into an array. `totalFilesScanned` counts filtered-out objects too; `lastScannedFile` is where the next batch should resume.

### `streamZipDataTo(params)` → `{ zip, zippedFiles, totalFilesScanned, lastScannedFile }`

Writes a zip into `params.pipe` (any Writable). Resolves once the archive has finished. `zip` is the archiver instance with a `manifest` property equal to `zippedFiles`. Pass `createPipe` instead of `pipe` to create the destination lazily; it is only called when the first entry is written, so an empty prefix writes nothing.

### `zipToFile(params)` → `{ ..., filePath }`

As above, into a local file. Resolves after the file handle is closed.

### `zipToFileFragments(params)` → `result[]`

Repeats `zipToFile` from `lastScannedFile` until the prefix is exhausted. Fragments are named `name_1.zip`, `name_2.zip`, ... Empty fragments are deleted and do not consume a number. `params.onFragment(result, index)` is awaited after each fragment.

### `zipToS3File(params)` → `{ key, etag, location, zippedFiles, totalFilesScanned, lastScannedFile }`

Streams the archive straight into a multipart upload; nothing touches the local disk, so it works on Lambda and read-only filesystems. If `key` has no `/` it is placed inside `prefix`. When the prefix yields no entries nothing is uploaded and `key` is `null`.

### `zipToS3FileFragments(params)` → `result[]`

Fragments streamed and uploaded as `key_1.zip`, `key_2.zip`, ... Each result has the same shape as `zipToS3File`.

### `uploadLocalFileToS3(localFileName, key, { contentType, signal })`

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
- **One set of param names.** `prefix` replaces `folderName`/`s3FolderName`, `filePath` replaces `zipFileName`, `key` replaces `s3ZipFileName`. The old names are still accepted as aliases, but results use the new names: `filePath`, `key`, `etag`, `location`.
- **AWS SDK v3.** `aws-sdk` and `@auth0/s3` are no longer dependencies. `accessKeyId`/`secretAccessKey`/`region` are now optional. `s3ForcePathStyle` is accepted as an alias of `forcePathStyle`.
- **Silent by default.** Pass `logger: console` to get the old progress output.
- **No temp files.** The S3 methods stream directly into a multipart upload. The `tmpDir` param is gone.
- **Fragment naming** is consistent and 1-based for both local and S3 fragments (`name_1.zip`, `name_2.zip`, ...). Previously the first local fragment had no suffix and S3 fragments were 0-based.
- `zipToFileFragments` no longer returns an `events` object; use `params.onFragment` instead.
- Fragment methods reject on the first error instead of collecting errors.
- `calculateFileName(file, { prefix })` receives a context argument. The default implementation strips the prefix (same result as before for non-root folders).
- `init()` was removed. Construct a new instance instead.

## License

MIT
