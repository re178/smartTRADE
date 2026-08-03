// checkCollections.js – Inspect database collections and counts
require('dotenv').config();
const mongoose = require('mongoose');

async function check() {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  const collections = await db.listCollections().toArray();
  console.log('📂 Collections in database:');
  for (const coll of collections) {
    const count = await db.collection(coll.name).countDocuments();
    console.log(`   ${coll.name}: ${count} documents`);
  }
  process.exit(0);
}
check();
