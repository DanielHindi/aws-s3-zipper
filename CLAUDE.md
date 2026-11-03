# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`aws-s3-zipper` is a single-file npm library (`index.js`, CommonJS, Promise-based) that zips the contents of an S3 "folder" to a stream, a local file, local file fragments, an S3 object, or S3 object fragments. Built on AWS SDK v3 (`@aws-sdk/client-s3`, `@aws-sdk/lib-storage`) and `archiver`. Types live in `index.d.ts`. Node 20+.

## Commands

- Install: `npm install`
- Test: `npm test` (Node's built-in `node --test`, no network; S3 is mocked with `aws-sdk-client-mock`)
- Single test file: `node --test test/s3zipper.test.js`
- Single test by name: `node --test --test-name-pattern="maxFileSize" test/`
- Lint: `npm run lint` (ESLint flat config in `eslint.config.js`)
- CI runs lint + tests on Node 20/22/24 (`.github/workflows/ci.yml`).

## Architecture

Everything is the `S3Zipper` class in `index.js`. Methods form a layered call chain:

```
scanFiles (generator)    paginateListObjectsV2 (StartAfter=startKey, Delimiter='/' unless recursive),
   |                     applies filterOutFiles, enforces maxFileCount / maxFileSize cut-offs,
   |                     yields lazily and mutates a `stats` object; getFiles() just collects it
   v
streamZipDataTo          consumes scanFiles, GetObject in batches of `concurrency`,
   |                     archive.append(stream) in order, pipes to params.pipe, awaits finalize()
   v
zipToFile                wraps streamZipDataTo with an fs write stream, awaits 'close'
   |
   +--> zipToFileFragments   loops zipToFile from lastScannedFile.Key until a pass scans 0
   |                          objects; awaits params.onFragment per non-empty fragment
   |
   +--> zipToS3File          zipToFile to a temp file, uploadLocalFileToS3, rm in finally
   |
   +--> zipToS3FileFragments zipToFileFragments with an onFragment that uploads and removes
                             each fragment
```

Invariants that are easy to break:

- **Differential zipping** relies on `startKey` → `StartAfter` and on every result carrying `lastScannedFile` and `zippedFiles[].Key` so callers can resume.
- **Fragment rules** in `scanFiles`: an object larger than `maxFileSize` is zipped alone only when it is first in the batch; otherwise the batch ends before it. `totalFilesScanned` must include filtered-out objects, since the fragment loop stops only when it is 0.
- **Folder placeholders** (keys ending in `/`) are scanned and counted but never appended. A fragment containing only a placeholder is empty, gets deleted, and does not consume a fragment number.
- **`filterOutFiles(file)` and `calculateFileName(file, { prefix, folderName })`** are public override points documented in the README. Keep their signatures.
- **Prefix handling** goes through `toPrefix()`: `''` means the bucket root, leading/trailing slashes are stripped.
- **No buffering**: `GetObject` bodies are passed to archiver as streams. Do not read them into memory.
- **Logging** only via `this.logger` (silent by default). No `console.*` in library code.

## Tests

`test/helpers.js` provides `fakeBucket()` (mocked `S3Client` backed by a `{ key: contents }` object, with a `uploads` array capturing `PutObject` bodies), `collector()` (a Writable that buffers), and `readZip()` (yauzl-based zip reader). Add tests against those rather than hitting S3.

## README

README.md is the public API doc and includes the 1.x → 2.x migration notes. Any change to params, result shapes, or fragment naming must be mirrored there and in `index.d.ts`.
