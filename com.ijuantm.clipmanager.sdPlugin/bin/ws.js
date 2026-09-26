'use strict';

// Minimal RFC 6455 client: Stream Deck bundles Node 20, which has no built-in WebSocket client.
const http = require('node:http');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const ACCEPT_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OP_CONTINUATION = 0x0;
const OP_TEXT = 0x1;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

class WsClient extends EventEmitter {
  constructor(url) {
    super();
    const { hostname, port, pathname, search } = new URL(url);
    const key = crypto.randomBytes(16).toString('base64');
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.closeCode = null;
    this.closed = false;

    const req = http.request({
      hostname,
      port,
      path: pathname + search,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13',
      },
    });
    req.setTimeout(5000, () => req.destroy());
    req.on('upgrade', (res, socket, head) => {
      const expected = crypto.createHash('sha1').update(key + ACCEPT_GUID).digest('base64');
      if (res.headers['sec-websocket-accept'] !== expected) {
        socket.destroy();
        return this.finish(1002);
      }
      req.setTimeout(0);
      this.socket = socket;
      socket.setNoDelay(true);
      socket.on('data', (chunk) => this.receive(chunk));
      socket.on('close', () => this.finish(1006));
      socket.on('error', () => socket.destroy());
      this.emit('open');
      if (head.length) this.receive(head);
    });
    req.on('response', (res) => {
      res.resume();
      this.finish(1002);
    });
    req.on('error', () => this.finish(1006));
    req.end();
  }

  send(text) {
    this.write(OP_TEXT, Buffer.from(text, 'utf8'));
  }

  close() {
    const code = Buffer.alloc(2);
    code.writeUInt16BE(1000);
    this.write(OP_CLOSE, code);
    this.socket?.end();
  }

  write(opcode, payload) {
    if (!this.socket || this.socket.destroyed) return;
    const len = payload.length;
    const headerLen = len < 126 ? 2 : len < 65536 ? 4 : 10;
    const frame = Buffer.allocUnsafe(headerLen + 4 + len);
    frame[0] = 0x80 | opcode;
    if (len < 126) {
      frame[1] = 0x80 | len;
    } else if (len < 65536) {
      frame[1] = 0x80 | 126;
      frame.writeUInt16BE(len, 2);
    } else {
      frame[1] = 0x80 | 127;
      frame.writeBigUInt64BE(BigInt(len), 2);
    }
    const mask = crypto.randomBytes(4);
    mask.copy(frame, headerLen);
    for (let i = 0; i < len; i++) frame[headerLen + 4 + i] = payload[i] ^ mask[i & 3];
    this.socket.write(frame);
  }

  receive(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    while (this.buffer.length >= 2) {
      const b0 = this.buffer[0];
      const b1 = this.buffer[1];
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (this.buffer.length < 4) return;
        len = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (this.buffer.length < 10) return;
        len = Number(this.buffer.readBigUInt64BE(2));
        offset = 10;
      }
      let mask = null;
      if (b1 & 0x80) {
        if (this.buffer.length < offset + 4) return;
        mask = this.buffer.subarray(offset, offset + 4);
        offset += 4;
      }
      if (this.buffer.length < offset + len) return;
      const payload = Buffer.from(this.buffer.subarray(offset, offset + len));
      if (mask) for (let i = 0; i < len; i++) payload[i] ^= mask[i & 3];
      this.buffer = this.buffer.subarray(offset + len);
      this.frame(Boolean(b0 & 0x80), b0 & 0x0f, payload);
    }
  }

  frame(fin, opcode, payload) {
    if (opcode === OP_CLOSE) {
      this.closeCode = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
      this.write(OP_CLOSE, payload.subarray(0, 2));
      this.socket.end();
      return;
    }
    if (opcode === OP_PING) return this.write(OP_PONG, payload);
    if (opcode === OP_PONG) return;
    if (opcode !== OP_CONTINUATION) this.fragments = [];
    this.fragments.push(payload);
    if (!fin) return;
    const message = Buffer.concat(this.fragments).toString('utf8');
    this.fragments = [];
    this.emit('message', message);
  }

  finish(code) {
    if (this.closed) return;
    this.closed = true;
    this.emit('close', this.closeCode ?? code);
  }
}

module.exports = { WsClient };
