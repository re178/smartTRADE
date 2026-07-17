const mongoose = require('mongoose');

// ---------- Helper: Log endpoint ----------
function logEndpoint(name, req, result) {
  console.log('\n========== ' + name + ' ==========');
  console.log('Request Body:');
  console.log(JSON.stringify(req.body, null, 2));
  console.log('Response:');
  console.log(JSON.stringify(result, null, 2));
  console.log('==================================');
}

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

exports.createCommand = async (req, res) => {
  try {
    const { commandId, action, instrument, side, units, stopLoss, takeProfit, tradeId } = req.body;

    if (!commandId || !action) {
      const err = { error: 'commandId and action required', received: req.body };
      logEndpoint('createCommand', req, err);
      return res.status(400).json(err);
    }
    if (action === 'OPEN' && !instrument) {
      const err = { error: 'instrument required for OPEN orders', received: req.body };
      logEndpoint('createCommand', req, err);
      return res.status(400).json(err);
    }

    const newCmd = new Command({ commandId, action, instrument, side, units, stopLoss, takeProfit, tradeId });
    await newCmd.save();
    const response = { success: true };
    logEndpoint('createCommand', req, response);
    res.status(201).json(response);
  } catch (err) {
    const response = { error: err.message };
    logEndpoint('createCommand', req, response);
    res.status(500).json(response);
  }
};

exports.getPending = async (req, res) => {
  try {
    const commands = await Command.find({ status: 'pending' }).sort({ createdAt: 1 }).lean();
    const response = commands.map(c => ({
      commandId: c.commandId,
      action: c.action,
      instrument: c.instrument,
      side: c.side,
      units: c.units,
      stopLoss: c.stopLoss,
      takeProfit: c.takeProfit,
      tradeId: c.tradeId,
    }));
    logEndpoint('getPending', req, response);
    res.json(response);
  } catch (err) {
    const response = { error: err.message };
    logEndpoint('getPending', req, response);
    res.status(500).json(response);
  }
};

exports.handleResult = async (req, res) => {
  try {
    const { commandId, success, ticket, error } = req.body;
    if (!commandId) {
      const err = { error: 'commandId required', received: req.body };
      logEndpoint('handleResult', req, err);
      return res.status(400).json(err);
    }

    const command = await Command.findOne({ commandId });
    if (!command) {
      const err = { error: 'Command not found', received: req.body };
      logEndpoint('handleResult', req, err);
      return res.status(404).json(err);
    }

    command.status = success ? 'executed' : 'failed';
    command.ticket = ticket || 0;
    command.error = error || '';
    command.executedAt = new Date();
    await command.save();

    // Cleanup after 60 seconds
    setTimeout(async () => {
      try { await Command.deleteOne({ commandId }); } catch (e) {}
    }, 60000);

    const response = { success: true };
    logEndpoint('handleResult', req, response);
    res.json(response);
  } catch (err) {
    const response = { error: err.message };
    logEndpoint('handleResult', req, response);
    res.status(500).json(response);
  }
};

exports.getResult = async (req, res) => {
  try {
    const command = await Command.findOne({ commandId: req.params.commandId });
    if (!command) {
      const response = { error: 'Not found' };
      logEndpoint('getResult', req, response);
      return res.status(404).json(response);
    }
    if (command.status === 'pending') {
      const response = { error: 'Pending' };
      logEndpoint('getResult', req, response);
      return res.status(404).json(response);
    }
    const response = { success: command.status === 'executed', ticket: command.ticket, error: command.error };
    logEndpoint('getResult', req, response);
    res.json(response);
  } catch (err) {
    const response = { error: err.message };
    logEndpoint('getResult', req, response);
    res.status(500).json(response);
  }
};

exports.updateAccount = async (req, res) => {
  try {
    const { login, balance, equity, margin, free_margin, profit, currency, server, status = 'online' } = req.body;
    if (!login) {
      const err = { error: 'login required', received: req.body };
      logEndpoint('updateAccount', req, err);
      return res.status(400).json(err);
    }

    await Account.findOneAndUpdate(
      { login },
      { balance, equity, margin, free_margin, profit, currency, server, status, lastSeen: new Date() },
      { upsert: true, new: true }
    );
    const response = { success: true };
    logEndpoint('updateAccount', req, response);
    res.json(response);
  } catch (err) {
    const response = { error: err.message };
    logEndpoint('updateAccount', req, response);
    res.status(500).json(response);
  }
};

exports.getAccount = async (req, res) => {
  try {
    const account = await Account.findOne().sort({ lastSeen: -1 });
    let response;
    if (!account) {
      response = {
        login: 0,
        balance: 0,
        equity: 0,
        margin: 0,
        free_margin: 0,
        profit: 0,
        currency: 'USD',
        status: 'offline'
      };
    } else {
      response = account;
    }
    logEndpoint('getAccount', req, response);
    res.json(response);
  } catch (err) {
    const response = { error: err.message };
    logEndpoint('getAccount', req, response);
    res.status(500).json(response);
  }
};

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
    const response = { success: true };
    logEndpoint('updatePositions', req, response);
    res.json(response);
  } catch (err) {
    const response = { error: err.message };
    logEndpoint('updatePositions', req, response);
    res.status(500).json(response);
  }
};

exports.getPositions = async (req, res) => {
  try {
    const latest = await Account.findOne().sort({ lastSeen: -1 });
    let response;
    if (!latest) {
      response = { positions: [] };
    } else {
      const positions = await Position.find({ login: latest.login }).lean();
      response = { positions };
    }
    logEndpoint('getPositions', req, response);
    res.json(response);
  } catch (err) {
    const response = { error: err.message };
    logEndpoint('getPositions', req, response);
    res.status(500).json(response);
  }
};

exports.handleHeartbeat = async (req, res) => {
  try {
    const { login, status = 'online', timestamp } = req.body;
    if (!login) {
      const err = { error: 'login required', received: req.body };
      logEndpoint('handleHeartbeat', req, err);
      return res.status(400).json(err);
    }

    await Account.findOneAndUpdate(
      { login },
      { status, lastSeen: new Date() },
      { upsert: true }
    );
    const response = { success: true };
    logEndpoint('handleHeartbeat', req, response);
    res.json(response);
  } catch (err) {
    const response = { error: err.message };
    logEndpoint('handleHeartbeat', req, response);
    res.status(500).json(response);
  }
};

exports.sync = async (req, res) => {
  try {
    const { login } = req.body;
    if (!login) {
      const err = { error: 'login required', received: req.body };
      logEndpoint('sync', req, err);
      return res.status(400).json(err);
    }

    await Account.findOneAndUpdate(
      { login },
      { status: 'online', lastSeen: new Date() },
      { upsert: true }
    );
    const response = { success: true };
    logEndpoint('sync', req, response);
    res.json(response);
  } catch (err) {
    const response = { error: err.message };
    logEndpoint('sync', req, response);
    res.status(500).json(response);
  }
};
