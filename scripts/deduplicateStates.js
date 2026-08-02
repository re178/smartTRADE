// deduplicateStates.js – Remove duplicate states keeping only the first
require('dotenv').config();
const mongoose = require('mongoose');

async function deduplicate() {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  const collection = db.collection('historicalstates');

  const pipeline = [
    {
      $group: {
        _id: { symbol: '$symbol', timeframe: '$timeframe', timestamp: '$timestamp' },
        ids: { $push: '$_id' },
        count: { $sum: 1 }
      }
    },
    { $match: { count: { $gt: 1 } } }
  ];

  const duplicates = await collection.aggregate(pipeline).toArray();
  console.log(`Found ${duplicates.length} duplicate groups.`);

  let removed = 0;
  for (const dup of duplicates) {
    // Keep the first, delete the rest
    const idsToDelete = dup.ids.slice(1);
    if (idsToDelete.length > 0) {
      await collection.deleteMany({ _id: { $in: idsToDelete } });
      removed += idsToDelete.length;
    }
  }

  console.log(`✅ Removed ${removed} duplicate states.`);
  console.log(`✅ Remaining states: ${await collection.countDocuments()}`);
  process.exit(0);
}

deduplicate().catch(err => {
  console.error('❌ Error:', err);
  process.exit(1);
});
