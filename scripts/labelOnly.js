// scripts/backfillTradePnL.js
require('dotenv').config();
const mongoose = require('mongoose');

async function backfill() {
  await mongoose.connect(process.env.MONGODB_URI);
  const Trade = require('../models/Trade');

  const trades = await Trade.find({ status: 'CLOSED', pnl: 0, realizedProfit: 0 }).lean();
  console.log(`Found ${trades.length} closed trades with zero P&L.`);

  let updated = 0;
  for (const t of trades) {
    if (!t.openPrice || !t.closePrice || !t.lotSize) continue;
    const multiplier = t.side && t.side.toUpperCase() === 'BUY' ? 1 : -1;
    const pnl = (t.closePrice - t.openPrice) * t.lotSize * multiplier;
    if (pnl !== 0) {
      await Trade.updateOne(
        { _id: t._id },
        { $set: { pnl, realizedProfit: pnl } }
      );
      updated++;
    }
  }
  console.log(`✅ Updated ${updated} trades.`);
  process.exit(0);
}
backfill().catch(err => console.error(err));
