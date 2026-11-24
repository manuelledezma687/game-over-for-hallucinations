/**
 * Closes Genkit app processes left behind by a previous run.
 *
 * Each running app writes .genkit/runtimes/<id>.json with its process id. The Genkit CLI is
 * supposed to stop the app when it finishes, but on recent Windows 11 that step crashes
 * (it needs wmic.exe), so the app keeps running. The next evaluation can then hang, or even
 * talk to the OLD app (for example v1 while you are evaluating v2).
 */
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export function cleanupRuntimes(root = process.cwd()): number[] {
  const dir = path.join(root, '.genkit', 'runtimes');
  if (!existsSync(dir)) return [];
  const closed: number[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const full = path.join(dir, file);
    try {
      const { pid } = JSON.parse(readFileSync(full, 'utf8')) as { pid?: number };
      if (pid && pid !== process.pid && isAlive(pid)) {
        process.kill(pid, 'SIGKILL');
        closed.push(pid);
      }
    } catch {
      // unreadable file: just remove it
    }
    rmSync(full, { force: true });
  }
  if (closed.length) console.log(`🧹 Closed ${closed.length} leftover Genkit app process(es): ${closed.join(', ')}`);
  return closed;
}
