/**
 * Operator tool: brings existing files and folders into the S3 layout that mirrors the app. New changes
 * are handled by the running backend; this is for data from before that. Shows the plan by default.
 *   npm run sync-s3                                  # dry run, changes nothing
 *   npm run sync-s3 -- --apply --log moves.jsonl [--limit 1]
 *
 * --log is required with --apply. Each move is written to it before its original is deleted, so the
 * old and new key of every file can always be recovered.
 */
import fs from 'node:fs';
import { connectDb, disconnectDb } from '../lib/db.js';
import { s3LayoutService } from '../services/s3Layout.service.js';

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
  if (!apply) {
    const plan = await s3LayoutService.plan();
    for (const f of plan.folders) console.log(`folder  ${f}`);
    for (const m of plan.moves) console.log(`${m.from}\n   -> ${m.to}`);
    console.log(`Dry run. Would create ${plan.folders.length} folder(s) and move ${plan.moves.length} file(s).`);
  } else {
    const result = await s3LayoutService.syncExisting({
      limit,
      onMoved: (m) => {
        const fd = fs.openSync(log!, 'a');
        fs.writeSync(fd, `${JSON.stringify({ ...m, at: new Date().toISOString() })}\n`);
        fs.fsyncSync(fd);
        fs.closeSync(fd);
      },
    });
    console.log(`Folders created: ${result.foldersCreated.length}`);
    console.log(`Files moved: ${result.moved.length}`);
    console.log(`Failed, will retry: ${result.failed.length}`, result.failed);
    console.log(`Left in place: ${result.skipped.length}`, result.skipped);
    console.log(`Old objects not removed: ${result.leftovers.length}`, result.leftovers);
  }
  await disconnectDb();
}

main().catch(async (err) => {
  console.error((err as Error).message);
  await disconnectDb();
  process.exit(1);
});
