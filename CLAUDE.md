# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`aws-s3-zipper` is a single-file npm library (`src/index.ts`, Promise-based) that zips the objects under an S3 prefix to a stream, a local file, local file fragments, an S3 object, or S3 object fragments. Built on AWS SDK v3 (`@aws-sdk/client-s3`, `@aws-sdk/lib-storage`) and `archiver`. Node 20+.

Built with `tsup` into `dist/` as ESM (`index.mjs`), CJS (`index.cjs`) and declarations. `dist/` is gitignored and produced by `npm run build` (also run by `pretest` and `prepack`). A footer in `tsup.config.ts` makes the CJS build export the class itself so `const S3Zipper = require('aws-s3-zipper')` works; `test/packaging.test.js` guards that contract.

## Commands

- Install: `npm install`
- Build: `npm run build` (tsup). Tests require a build; `npm test` runs it via `pretest`.
- Test: `npm test` (Node's built-in `node --test`, no network; S3 is mocked with `aws-sdk-client-mock`)
- Single test file (after a build): `node --test test/s3zipper.test.js`
- Single test by name: `node --test --test-name-pattern="maxFileSize" test/`
- Type-check: `npm run typecheck`
- Lint: `npm run lint` (ESLint flat config in `eslint.config.js`, JS + TS)
- CI runs lint, typecheck and tests on Node 20/22/24 (`.github/workflows/ci.yml`).
- `@types/archiver` is pinned to v6 on purpose: v8 describes archiver 8's class API, while we use archiver 7's callable factory.

## Architecture

Everything is the `S3Zipper` class in `src/index.ts`; public types are exported from the same file. Methods form a layered call chain:

```
scanFiles (generator)    paginateListObjectsV2 (StartAfter=startKey, Delimiter='/' unless recursive),
   |                     applies filterOutFiles, enforces maxFileCount / maxFileSize cut-offs,
   |                     yields lazily and mutates a `stats` object; getFiles() just collects it
   v
streamZipDataTo          consumes scanFiles through a sliding window of `concurrency` GetObject
   |                     requests; appends one entry at a time and waits for archiver's 'entry'
   |                     event before fetching the next; pipes to params.pipe, awaits finalize()
   v
zipToFile                wraps streamZipDataTo with an fs write stream, awaits 'close'
   |
   +--> zipToS3File          streamZipDataTo with createPipe -> PassThrough -> lib-storage Upload;
   |                         no temp file; createPipe is only called on the first entry so an
   |                         empty folder uploads nothing
   |
   +--> zipToFileFragments / zipToS3FileFragments
                             both go through fragmentLoop(): run one fragment from startKey,
                             keep non-empty ones, resume from lastScannedFile.Key until a pass
                             scans 0 objects; awaits params.onFragment per kept fragment
```

Invariants that are easy to break:

- **Differential zipping** relies on `startKey` → `StartAfter` and on every result carrying `lastScannedFile` and `zippedFiles[].Key` so callers can resume.
- **Fragment rules** in `scanFiles`: an object larger than `maxFileSize` is zipped alone only when it is first in the batch; otherwise the batch ends before it. `totalFilesScanned` must include filtered-out objects, since the fragment loop stops only when it is 0.
- **Folder placeholders** (keys ending in `/`) are scanned and counted but never appended. A fragment containing only a placeholder is empty, gets deleted (local) or never uploaded (S3), and does not consume a fragment number.
- **No local disk in the S3 path.** `zipToS3File` must keep working on read-only filesystems; there is a test that asserts no `fs` writes happen.
- **`filterOutFiles(file)` and `calculateFileName(file, { prefix })`** are public override points documented in the README. Keep their signatures.
- **Param names** are `prefix`, `filePath`, `key` throughout. Every public method runs `normalizeParams()` first, which maps the 1.x aliases (`folderName`, `s3FolderName`, `zipFileName`, `s3ZipFileName`) onto them; internal code must only read the canonical names.
- **Prefix handling** goes through `toPrefix()`: `''` means the bucket root, leading/trailing slashes are stripped.
- **No buffering**: `GetObject` bodies are passed to archiver as streams. Do not read them into memory.
- **Logging** only via `this.logger` (silent by default). No `console.*` in library code.
- **AbortSignal** must reach every I/O: `pages()` and `GetObject` get `{ abortSignal }`, `startUpload()` wires it to lib-storage's `abortController`, and `streamZipDataTo` fails the archive on `abort`. Listeners are removed on completion. `Upload.done()` may only be called once per instance.

## Tests

`test/helpers.js` provides `fakeBucket()` (mocked `S3Client` backed by a `{ key: contents }` object, with a `uploads` array capturing `PutObject` bodies), `collector()` (a Writable that buffers), and `readZip()` (yauzl-based zip reader). Add tests against those rather than hitting S3.

## README

README.md is the public API doc and includes the 1.x → 2.x migration notes. Any change to params, result shapes, or fragment naming must be mirrored there; the exported interfaces in `src/index.ts` are the source of the published declarations.
