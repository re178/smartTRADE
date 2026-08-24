// scripts/cleanupHistoricalCollections.js
// Drops historicalstates and historicaloutcomes collections.
// Keeps historicalcandles intact.
// Run after verifying backup.

require('dotenv').config();
const mongoose = require('mongoose');
const readline = require('readline');

// ---- Configuration ----
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/rts';
const COLLECTIONS_TO_DROP = ['historicalstates', 'historicaloutcomes'];

// ---- Helper: ask for confirmation ----
function askQuestion(query) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise(resolve => rl.question(query, ans => {
    rl.close();
    resolve(ans.toLowerCase().trim());
  }));
}

// ---- Main ----
async function cleanup() {
  console.log('==================================================');
  console.log('  HISTORICAL COLLECTION CLEANUP');
  console.log('==================================================\n');

  console.log(`⚠️  WARNING: This script will DROP the following collections:`);
  console.log(`   - historicalstates`);
  console.log(`   - historicaloutcomes`);
  console.log(`\nThe collection "historicalcandles" will be PRESERVED.\n`);

  console.log('📌 Recommended safety step:');
  console.log('   Run a backup first:');
  console.log('   mongodump --db rts --collection historicalstates --out ./backup');
  console.log('   mongodump --db rts --collection historicaloutcomes --out ./backup\n');

  const answer = await askQuestion('Type "DROP" to confirm deletion: ');
  if (answer !== 'drop') {
    console.log('❌ Aborted by user.');
    process.exit(0);
  }

  console.log(`\n🔌 Connecting to ${MONGO_URI}...`);
  await mongoose.connect(MONGO_URI);
  console.log('✅ Connected.\n');

  const conn = mongoose.connection;

  // Check if collections exist
  const collections = await conn.db.listCollections().toArray();
  const collectionNames = collections.map(c => c.name);

  for (const name of COLLECTIONS_TO_DROP) {
    if (collectionNames.includes(name)) {
      console.log(`   Dropping collection: ${name}...`);
      await conn.db.dropCollection(name);
      console.log(`   ✅ Dropped ${name}.`);
    } else {
      console.log(`   ⚠️ Collection ${name} does not exist, skipping.`);
    }
  }

  console.log('\n✅ Cleanup complete.');
  console.log('   Remaining collections:');
  const remaining = await conn.db.listCollections().toArray();
  for (const c of remaining) {
    console.log(`   - ${c.name}`);
  }

  process.exit(0);
}

// ---- Error Handling ----
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
  process.exit(1);
});

cleanup();
