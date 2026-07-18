const mongoose = require('mongoose');

const Mt5HeartbeatSchema = new mongoose.Schema({
  login: {
    type: Number,
    required: true,
    unique: true,
  },
  status: String,      // 'online', 'offline', 'started'
  lastHeartbeat: Number,
  updatedAt: {
    type: Date,
    default: Date.now,
  },
});

module.exports = mongoose.model('Mt5Heartbeat', Mt5HeartbeatSchema);
