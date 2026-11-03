# Changelog

## 2.0.0

Full rewrite on AWS SDK v3 with a Promise-based API. See the README's "Migrating from 1.x" section for the breaking changes.

### Added
- Optional credentials: use the SDK default credential chain (IAM roles, env vars, profiles). Closes #21, #41, PR #22, PR #43.
- `endpoint` and `forcePathStyle` options for S3-compatible services. Closes #53, PR #52.
- `sessionToken` support kept from PR #51 (which had a syntax error on master).
- `logger` option; the library is silent by default. Closes #55.
- `concurrency` option for bounded parallel object fetches. Supersedes PR #38.
- Bucket-root zipping with `folderName: ''`. Closes #33.
- S3 methods stream the archive directly into a multipart upload; no temp files, so Lambda works out of the box. Closes PR #8, PR #25.
- `scanFiles()` async generator; listing is lazy and stops paginating at the batch cut-off. `pageSize` option.
- Object fetches use a sliding window of `concurrency` with per-entry back-pressure, so memory stays bounded.
- `uploadOptions` passthrough to `@aws-sdk/lib-storage`.
- `signal` (AbortSignal) param on every method; cancels listing, fetches, archiving and uploads.
- `onFragment` hook for fragment methods.
- TypeScript definitions. Closes #37, #49.
- Test suite (`node --test` with mocked S3), ESLint, GitHub Actions CI.

### Changed
- Objects are streamed into the archive instead of buffered in memory; aborting the destination stream aborts the archive. Addresses #57, #24, #26.
- Archiver upgraded from 0.21 to 7.x, fixing corrupted zips with many small files. Closes #39.
- Multipart uploads via `@aws-sdk/lib-storage`; upload progress logs once per 10% step when the size is known. Supersedes PR #40.
- Stream completion is awaited properly; the 1-second `setTimeout` hacks are gone.
- Fragment numbering is 1-based for both local and S3 fragments.

### Removed
- Dependencies `aws-sdk` (v2), `@auth0/s3`, `async`. Makes dependabot PRs #54 and #56 obsolete.
- Callback and positional-argument call styles.
- `init()`.

## 1.4.0 and earlier

See the git history.
