// dropBrokenData.js – Drop all broken historical data
// Run: node dropBrokenData.js

require('dotenv').config();
const mongoose = require('mongoose');
const readline = require('readline');

// ----- Configuration -----
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/rts';

// ----- Models (use existing or define minimal schemas) -----
// We need to access the collections, so we get the mongoose models.
// If the models are not yet defined, we can still drop collections via native driver.

async function dropCollections() {
  console.log('🔌 Connecting to MongoDB...');
  await mongoose.connect(MONGODB_URI);
  console.log('✅ Connected.\n');

  const db = mongoose.connection.db;

  // List of collections to drop
  const collectionsToDrop = ['historicalcandles', 'historicalstates', 'historicaloutcomes'];
  // Note: collection names are lowercased by Mongoose by default.

  console.log('⚠️  The following collections will be PERMANENTLY DELETED:');
  collectionsToDrop.forEach(name => console.log(`   - ${name}`));
  console.log('\nThis action cannot be undone!');

  // Ask for confirmation
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const answer = await new Promise(resolve => {
    rl.question('Type "DROP" to confirm: ', resolve);
  });

  if (answer !== 'DROP') {
    console.log('❌ Aborted.');
    process.exit(0);
  }

  console.log('\n🗑️  Dropping collections...');

  for (const name of collectionsToDrop) {
    try {
      const collections = await db.listCollections({ name }).toArray();
      if (collections.length > 0) {
        await db.collection(name).drop();
        console.log(`✅ Dropped collection: ${name}`);
      } else {
        console.log(`ℹ️  Collection ${name} does not exist, skipping.`);
      }
    } catch (err) {
      console.error(`❌ Error dropping ${name}:`, err.message);
    }
  }

  console.log('\n✅ All broken data has been removed.');
  console.log('📌 You can now run the bulk fetcher EA to import real candles.');

  process.exit(0);
}

dropCollections().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
