import { renameSync, writeFileSync } from 'node:fs';
/** Owner-only because several callers store credentials. */
export function writeFileAtomic(path: string, data: string | Buffer) {
  writeFileSync(path + '.tmp', data, { mode: 0o600 }); renameSync(path + '.tmp', path);
}
