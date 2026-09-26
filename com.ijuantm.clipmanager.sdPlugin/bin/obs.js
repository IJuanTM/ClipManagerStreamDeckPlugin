'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { WsClient } = require('./ws');

const OBS_DIR = path.join(process.env.APPDATA ?? '', 'obs-studio');
const WEBSOCKET_CONFIG = path.join(OBS_DIR, 'plugin_config', 'obs-websocket', 'config.json');
const RETRY_MS = 3000;
const REQUEST_TIMEOUT_MS = 5000;
// General | Config | Scenes | Inputs | Outputs | SceneItems
const EVENT_SUBSCRIPTIONS = 1 | 2 | 4 | 8 | 64 | 128;

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('base64');

function readWebsocketConfig() {
  try {
    return JSON.parse(fs.readFileSync(WEBSOCKET_CONFIG, 'utf8'));
  } catch {
    return {};
  }
}

class ObsClient extends EventEmitter {
  constructor(log) {
    super();
    this.log = log;
    this.status = 'offline';
    this.ws = null;
    this.pending = new Map();
    this.nextRequestId = 1;
    this.retryTimer = null;
  }

  start() {
    this.connect();
  }

  reconnect() {
    this.ws?.close();
    this.setStatus('offline');
    this.connect();
  }

  connect() {
    clearTimeout(this.retryTimer);
    // Re-read every attempt so enabling the server or changing its password in OBS is picked up without restarting Stream Deck.
    const config = readWebsocketConfig();
    if (config.server_enabled === false) {
      this.setStatus('disabled');
      return this.scheduleRetry();
    }
    const ws = new WsClient(`ws://127.0.0.1:${config.server_port ?? 4455}/`);
    this.ws = ws;
    ws.on('message', (text) => {
      try {
        this.onMessage(ws, JSON.parse(text), config);
      } catch (err) {
        this.log(`bad message from OBS: ${err.message}`);
      }
    });
    ws.on('close', (code) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (code === 4009) this.log('OBS rejected the WebSocket password');
      for (const { reject } of this.pending.values()) reject(new Error('OBS disconnected'));
      this.pending.clear();
      this.setStatus('offline');
      this.scheduleRetry();
    });
  }

  scheduleRetry() {
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.connect(), RETRY_MS);
  }

  setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    this.log(`OBS status: ${status}`);
    this.emit('status', status);
  }

  onMessage(ws, msg, config) {
    switch (msg.op) {
      case 0: {
        const identify = { rpcVersion: 1, eventSubscriptions: EVENT_SUBSCRIPTIONS };
        const auth = msg.d.authentication;
        if (auth) {
          const secret = sha256((config.server_password ?? '') + auth.salt);
          identify.authentication = sha256(secret + auth.challenge);
        }
        ws.send(JSON.stringify({ op: 1, d: identify }));
        break;
      }
      case 2:
        this.setStatus('ready');
        break;
      case 5:
        this.emit('event', msg.d.eventType, msg.d.eventData ?? {});
        break;
      case 7: {
        const entry = this.pending.get(msg.d.requestId);
        if (!entry) break;
        this.pending.delete(msg.d.requestId);
        clearTimeout(entry.timer);
        const status = msg.d.requestStatus;
        if (status.result) entry.resolve(msg.d.responseData ?? {});
        else entry.reject(new Error(`${msg.d.requestType} failed (${status.code}): ${status.comment ?? ''}`));
        break;
      }
    }
  }

  request(requestType, requestData) {
    if (this.status !== 'ready' || !this.ws) return Promise.reject(new Error('OBS not connected'));
    const requestId = String(this.nextRequestId++);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`${requestType} timed out`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(requestId, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ op: 6, d: { requestType, requestId, requestData } }));
    });
  }
}

module.exports = { ObsClient, OBS_DIR };
