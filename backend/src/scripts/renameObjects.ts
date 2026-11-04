/**
 * Operator tool: gives files stored under a UUID a readable S3 key. Shows the plan unless told to apply.
 *   npm run rename-objects                                  # dry run, changes nothing
 *   npm run rename-objects -- --apply --log renames.jsonl [--limit 1]
 *
 * --log is required with --apply. Each rename is written to it before its original is deleted, so
 * the old and new key of every file can always be recovered.
 */
import fs from 'node:fs';
import { connectDb, disconnectDb } from '../lib/db.js';
import { renameUuidObjects } from '../services/renameObjects.service.js';

function option(name: string) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const limit = option('--limit') ? Number(option('--limit')) : undefined;
  const log = option('--log');
  if (apply && !log) throw new Error('--apply needs --log <file>');

  await connectDb(undefined, { syncIndexes: false });
  const result = await renameUuidObjects({
    apply,
    limit,
    onRenamed: (r) => {
      const fd = fs.openSync(log!, 'a');
      fs.writeSync(fd, `${JSON.stringify({ ...r, at: new Date().toISOString() })}\n`);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
    },
  });

  const name = (key: string) => key.split('/').slice(2).join('/');
  for (const r of result.planned) console.log(`${name(r.from)}  ->  ${name(r.to)}`);
  console.log(apply ? `Renamed: ${result.renamed.length}` : `Dry run. Would rename: ${result.planned.length}`);
  console.log(`Skipped: ${result.skipped.length}`, result.skipped.map((s) => `${s.name}: ${s.reason}`));
  console.log(`Old objects not removed: ${result.leftovers.length}`, result.leftovers);
  await disconnectDb();
}

main().catch(async (err) => {
  console.error((err as Error).message);
  await disconnectDb();
  process.exit(1);
});
