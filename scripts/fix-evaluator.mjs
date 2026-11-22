// Fixes a bug in @genkit-ai/evaluator 1.44.0: its ES-module build uses `__dirname`,
// which does not exist in ES modules, so every LLM-judge metric fails with
// "ReferenceError: __dirname is not defined". Runs automatically after `npm install`.
// Safe to run many times; does nothing once Genkit ships a fixed version.
import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
let helper;
try {
  helper = path.join(path.dirname(require.resolve('@genkit-ai/evaluator')), 'metrics', 'helper.mjs');
} catch {
  process.exit(0); // evaluator not installed
}
if (!existsSync(helper)) process.exit(0);

const BROKEN = 'function getDirName() {\n  return __dirname;\n}';
const FIXED =
  'function getDirName() {\n  return __gofhPath.dirname(__gofhFileURLToPath(import.meta.url));\n}';
const IMPORTS = 'import __gofhPath from "node:path";\nimport { fileURLToPath as __gofhFileURLToPath } from "node:url";\n';

const source = readFileSync(helper, 'utf8');
if (source.includes('__gofhFileURLToPath')) {
  console.log('fix-evaluator: already patched');
} else if (source.includes(BROKEN)) {
  writeFileSync(helper, IMPORTS + source.replace(BROKEN, FIXED));
  console.log('fix-evaluator: patched @genkit-ai/evaluator (ESM __dirname bug)');
} else {
  console.log('fix-evaluator: nothing to patch (Genkit may have fixed it)');
}
