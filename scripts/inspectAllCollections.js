// scripts/inspectAllCollections.js – Full database inspection
// Run: node scripts/inspectAllCollections.js

require('dotenv').config();
const mongoose = require('mongoose');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/rts';

async function inspectAll() {
  console.log('🔌 Connecting to MongoDB...');
  await mongoose.connect(MONGODB_URI);
  console.log('✅ Connected.\n');

  const db = mongoose.connection.db;

  // Get list of all collections
  const collections = await db.listCollections().toArray();
  console.log(`📂 Found ${collections.length} collections in the database.\n`);

  for (const collInfo of collections) {
    const collName = collInfo.name;
    const collection = db.collection(collName);

    // Count documents
    const count = await collection.countDocuments();
    console.log(`📊 Collection: ${collName} (${count} documents)`);

    if (count === 0) {
      console.log('   (empty)\n');
      continue;
    }

    // Get up to 2 sample documents
    const samples = await collection.find().limit(2).toArray();
    console.log(`   Sample documents (${samples.length} shown):`);
    samples.forEach((doc, i) => {
      // Convert ObjectId and Date to strings for readability
      const cleanDoc = JSON.parse(JSON.stringify(doc, (key, value) => {
        if (value instanceof Date) {
          return value.toISOString();
        }
        if (value && value._bsontype === 'ObjectID') {
          return value.toString();
        }
        return value;
      }));
      console.log(`   Sample #${i+1}:`);
      console.log(JSON.stringify(cleanDoc, null, 2));
      console.log('');
    });

    console.log('---\n');
  }

  console.log('✅ Inspection complete.');
  process.exit(0);
}

inspectAll().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
