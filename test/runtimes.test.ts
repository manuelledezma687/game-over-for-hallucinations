import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { cleanupRuntimes } from '../scripts/runtimes.js';

test('closes a leftover Genkit app and removes its runtime file', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'gofh-'));
  mkdirSync(path.join(root, '.genkit', 'runtimes'), { recursive: true });
  const orphan = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const file = path.join(root, '.genkit', 'runtimes', `${orphan.pid}-3100.json`);
  writeFileSync(file, JSON.stringify({ id: `${orphan.pid}-3100`, pid: orphan.pid }));
  const exited = new Promise((resolve) => orphan.on('exit', resolve));
  assert.deepEqual(cleanupRuntimes(root), [orphan.pid]);
  await exited;
  assert.equal(existsSync(file), false);
});

test('does nothing when there is no .genkit folder', () => {
  assert.deepEqual(cleanupRuntimes(mkdtempSync(path.join(tmpdir(), 'gofh-'))), []);
});
