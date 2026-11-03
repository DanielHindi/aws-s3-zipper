import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['cjs', 'esm'],
  outExtension: ({ format }) => ({ js: format === 'cjs' ? '.cjs' : '.mjs' }),
  dts: true,
  target: 'node20',
  platform: 'node',
  sourcemap: true,
  clean: true,
  splitting: false,
  // Keep `const S3Zipper = require('aws-s3-zipper')` working: make the CJS
  // module export the class itself, with the named exports attached to it.
  footer: {
    js: "if (typeof module !== 'undefined' && module.exports && module.exports.default) { module.exports = Object.assign(module.exports.default, module.exports); }",
  },
});
