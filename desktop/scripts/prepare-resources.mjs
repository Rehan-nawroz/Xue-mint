import { cp, mkdir, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Copies the built gallery into the Tauri bundle. The server serves this copy,
// so the installed app never depends on the source tree.
const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, '..', '..', 'web', 'dist');
const target = join(here, '..', 'src-tauri', 'resources', 'web');

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

if (!(await exists(join(source, 'index.html')))) {
  console.error('web/dist is missing. Run `npm run build -w @xue-mint/web` first.');
  process.exit(1);
}

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await cp(source, target, { recursive: true });
console.log(`Prepared gallery resources in ${target}`);
