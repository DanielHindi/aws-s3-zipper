'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const pkg = require('../package.json');

test('CommonJS entry exports the class directly plus named/default aliases', () => {
  const Default = require('..');
  const { S3Zipper } = require('..');
  assert.equal(typeof Default, 'function');
  assert.equal(Default, S3Zipper);
  assert.equal(Default.default, Default);
});

test('ESM entry exposes default and named exports', async () => {
  // Self-reference by package name so the "exports" map is honoured.
  const mod = await import('aws-s3-zipper');
  assert.equal(typeof mod.default, 'function');
  assert.equal(mod.S3Zipper, mod.default);
});

test('package.json exports point at files that exist', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const entries = [pkg.main, pkg.module, pkg.types];
  for (const cond of Object.values(pkg.exports['.'])) entries.push(cond.types, cond.default);
  for (const file of entries) assert.ok(fs.existsSync(path.join(__dirname, '..', file)), `${file} missing`);
});
