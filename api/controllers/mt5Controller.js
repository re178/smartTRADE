const mongoose = require('mongoose');

// ---------- Models ----------
const commandSchema = new mongoose.Schema({
  commandId: { type: String, required: true, unique: true, index: true },
  action: { type: String, enum: ['OPEN', 'CLOSE', 'MODIFY'], required: true },
  instrument: String,
  side: { type: String, enum: ['BUY', 'SELL'] },
  units: Number,
  stopLoss: Number,
  takeProfit: Number,
  tradeId: { type: Number, default: 0 },
  status: { type: String, enum: ['pending', 'executed', 'failed'], default: 'pending', index: true },
  ticket: { type: Number, default: 0 },
  error: { type: String, default: '' },
  executedAt: Date,
}, { timestamps: true });
const Command = mongoose.model('MT5Command', commandSchema);

const accountSchema = new mongoose.Schema({
  login: { type: Number, required: true, unique: true, index: true },
  balance: Number,
  equity: Number,
  margin: Number,
  free_margin: Number,
  profit: Number,
  currency: String,
  server: String,
  status: { type: String, enum: ['online', 'offline'], default: 'online' },
  lastSeen: { type: Date, default: Date.now },
}, { timestamps: true });
const Account = mongoose.model('MT5Account', accountSchema);

const positionSchema = new mongoose.Schema({
  login: { type: Number, required: true, index: true },
  ticket: { type: Number, required: true, unique: true },
  symbol: String,
  type: { type: String, enum: ['BUY', 'SELL'] },
  volume: Number,
  price: Number,
  current_price: Number,
  profit: Number,
  stop_loss: Number,
  take_profit: Number,
  comment: String,
  magic: Number,
  swap: Number,
  open_time: Date,
  reason: Number,
  identifier: Number,
}, { timestamps: true });
const Position = mongoose.model('MT5Position', positionSchema);

// ---------- Controllers ----------

// 1. Create command (broker)
exports.createCommand = async (req, res) => {
  try {
    const { commandId, action, instrument, side, units, stopLoss, takeProfit, tradeId } = req.body;

    // FIX 1: Allow CLOSE/MODIFY without instrument
    if (!commandId || !action) {
      return res.status(400).json({ error: 'commandId and action required' });
    }
    if (action === 'OPEN' && !instrument) {
      return res.status(400).json({ error: 'instrument required for OPEN orders' });
    }

    const newCmd = new Command({ commandId, action, instrument, side, units, stopLoss, takeProfit, tradeId });
    await newCmd.save();
    res.status(201).json({ success: true });
  } catch (err) {
    console.error('MT5 createCommand error:', err);
    res.status(500).json({ error: err.message });
  }
};

// 2. Get pending commands (EA)
exports.getPending = async (req, res) => {
  try {
    const commands = await Command.find({ status: 'pending' }).sort({ createdAt: 1 }).lean();
    res.json(commands.map(c => ({
      commandId: c.commandId,
      action: c.action,
      instrument: c.instrument,
      side: c.side,
      units: c.units,
      stopLoss: c.stopLoss,
      takeProfit: c.takeProfit,
      tradeId: c.tradeId,
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// 3. Store execution result (EA)
exports.handleResult = async (req, res) => {
  try {
    const { commandId, success, ticket, error } = req.body;
    const command = await Command.findOne({ commandId });
    if (!command) return res.status(404).json({ error: 'Command not found' });

    command.status = success ? 'executed' : 'failed';
    command.ticket = ticket || 0;
    command.error = error || '';
    command.executedAt = new Date();
    await command.save();

    // FIX 3: Cleanup executed commands after 60 seconds
    setTimeout(async () => {
      try {
        await Command.deleteOne({ commandId });
      } catch (e) {
        // ignore
      }
    }, 60000);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// 4. Poll result (broker)
exports.getResult = async (req, res) => {
  try {
    const command = await Command.findOne({ commandId: req.params.commandId });
    if (!command) return res.status(404).json({ error: 'Not found' });
    if (command.status === 'pending') return res.status(404).json({ error: 'Pending' });
    res.json({ success: command.status === 'executed', ticket: command.ticket, error: command.error });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// 5. Account status (EA posts)
exports.updateAccount = async (req, res) => {
  try {
    const { login, balance, equity, margin, free_margin, profit, currency, server, status = 'online' } = req.body;
    if (!login) return res.status(400).json({ error: 'login required' });
    await Account.findOneAndUpdate(
      { login },
      { balance, equity, margin, free_margin, profit, currency, server, status, lastSeen: new Date() },
      { upsert: true, new: true }
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// 6. Account status (dashboard/broker GET)
exports.getAccount = async (req, res) => {
  try {
    const account = await Account.findOne().sort({ lastSeen: -1 });
    // FIX 2: Return default offline status instead of 404
    if (!account) {
      return res.json({
        login: 0,
        balance: 0,
        equity: 0,
        margin: 0,
        free_margin: 0,
        profit: 0,
        currency: 'USD',
        status: 'offline'
      });
    }
    res.json(account);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// 7. Positions (EA posts)
exports.updatePositions = async (req, res) => {
  try {
    const { login } = req.body;
    const positions = req.body.positions || [];
    let accountLogin = login;
    if (!accountLogin) {
      const latest = await Account.findOne().sort({ lastSeen: -1 });
      accountLogin = latest ? latest.login : 0;
    }
    await Position.deleteMany({ login: accountLogin });
    if (positions.length) {
      const docs = positions.map(p => ({
        login: accountLogin,
        ticket: p.ticket,
        symbol: p.symbol,
        type: p.type,
        volume: p.volume,
        price: p.price,
        current_price: p.current_price || p.price,
        profit: p.profit || 0,
        stop_loss: p.stop_loss || 0,
        take_profit: p.take_profit || 0,
        comment: p.comment || '',
        magic: p.magic || 0,
        swap: p.swap || 0,
        open_time: p.open_time ? new Date(p.open_time * 1000) : null,
        reason: p.reason || 0,
        identifier: p.identifier || 0,
      }));
      await Position.insertMany(docs);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// 8. Positions (dashboard/broker GET)
exports.getPositions = async (req, res) => {
  try {
    const latest = await Account.findOne().sort({ lastSeen: -1 });
    if (!latest) return res.json({ positions: [] });
    const positions = await Position.find({ login: latest.login }).lean();
    res.json({ positions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// 9. Heartbeat (EA)
exports.handleHeartbeat = async (req, res) => {
  try {
    const { login, status = 'online', timestamp } = req.body;
    if (!login) return res.status(400).json({ error: 'login required' });
    await Account.findOneAndUpdate(
      { login },
      { status, lastSeen: new Date() },
      { upsert: true }
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// 10. Sync (EA startup)
exports.sync = async (req, res) => {
  try {
    const { login } = req.body;
    if (!login) return res.status(400).json({ error: 'login required' });
    await Account.findOneAndUpdate(
      { login },
      { status: 'online', lastSeen: new Date() },
      { upsert: true }
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
