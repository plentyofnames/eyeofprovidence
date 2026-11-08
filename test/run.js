// deno run --allow-read test/run.js   (or: node test/run.js)
import { runTests } from './core.test.js';

const root = new URL('../', import.meta.url);
const deno = globalThis.Deno;
const load = deno
  ? (path) => deno.readFile(new URL(path, root)).catch(() => null)
  : async (path) => {
    const fs = await import('node:fs/promises');
    return fs.readFile(new URL(path, root)).then((b) => new Uint8Array(b)).catch(() => null);
  };
const failed = await runTests(load);
if (deno) deno.exit(failed ? 1 : 0);
else globalThis.process.exit(failed ? 1 : 0);
