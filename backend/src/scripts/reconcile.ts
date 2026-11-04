/**
 * Operator tool: reconcile storage counters and S3 objects with metadata, and run upload cleanup.
 *   npm run reconcile                 # dry run for objects, fixes counters
 *   npm run reconcile -- --delete-orphans
 */
import { connectDb, disconnectDb } from '../lib/db.js';
import { User } from '../models/index.js';
import { storageService } from '../services/storage.service.js';
import { runMaintenance } from '../jobs/maintenance.js';

async function main() {
  await connectDb();
  const deleteOrphans = process.argv.includes('--delete-orphans');
  console.log('Maintenance:', JSON.stringify(await runMaintenance()));
  for await (const u of User.find({}, { _id: 1 }).lean().cursor()) {
    const r = await storageService.reconcileUser(u._id);
    if (r.before && (r.before.used !== r.after.used || r.before.reserved !== r.after.reserved)) console.log('Fixed counters:', JSON.stringify(r));
  }
  const objects = await storageService.reconcileObjects({ deleteOrphans });
  console.log(`Orphan S3 objects: ${objects.orphanObjects.length}${deleteOrphans ? ' (deleted)' : ' (dry run)'}`);
  console.log(`Files with missing S3 objects: ${objects.missingObjects.length}`, objects.missingObjects.slice(0, 50));
  await disconnectDb();
}

main().catch(async (err) => {
  console.error(err);
  await disconnectDb();
  process.exit(1);
});
