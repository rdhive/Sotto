'use strict'

// Talks to the Python engine over loopback TCP, newline-delimited JSON.
//
// The engine is the source of truth and runs independently. This client
// reconnects forever, so starting the app before the engine, or restarting
// the engine underneath it, both just work.

const net = require('net')
const { EventEmitter } = require('events')

const RECONNECT_MS = 1000

class CoreClient extends EventEmitter {
  constructor (host, port) {
    super()
    this.host = host
    this.port = port
    this.connected = false
    this._sock = null
    this._buf = ''
    this._timer = null
    this._stopped = false
    this._seq = 0
    this._pending = new Map()
    // Set by the owner. Given the polished text, returns the corrected text.
    this.onTransform = null
  }

  start () {
    this._stopped = false
    this._connect()
  }

  stop () {
    this._stopped = true
    clearTimeout(this._timer)
    if (this._sock) this._sock.destroy()
  }

  _connect () {
    clearTimeout(this._timer)
    const sock = new net.Socket()
    this._sock = sock
    sock.setNoDelay(true)

    sock.connect(this.port, this.host, () => {
      this.connected = true
      this._buf = ''
      this.emit('connected')
      this.send({ cmd: 'hello' })
    })

    sock.on('data', (chunk) => {
      this._buf += chunk.toString('utf8')
      let nl
      while ((nl = this._buf.indexOf('\n')) !== -1) {
        const line = this._buf.slice(0, nl).trim()
        this._buf = this._buf.slice(nl + 1)
        if (line) this._receive(line)
      }
    })

    const drop = () => {
      if (!this.connected) return
      this.connected = false
      for (const { reject } of this._pending.values()) {
        reject(new Error('engine disconnected'))
      }
      this._pending.clear()
      this.emit('disconnected')
    }

    sock.on('error', drop)
    sock.on('close', () => {
      drop()
      if (!this._stopped) this._timer = setTimeout(() => this._connect(), RECONNECT_MS)
    })
  }

  _receive (line) {
    let msg
    try {
      msg = JSON.parse(line)
    } catch (err) {
      return
    }

    // The engine asks us to rewrite the text before it injects it. This is
    // how the dictionary reaches the clipboard: corrections live here, in
    // the main process, not in the engine.
    if (msg.type === 'transform') {
      let text = msg.text
      let applied = []
      try {
        if (this.onTransform) {
          const out = this.onTransform(msg.text)
          text = out.text
          applied = out.applied || []
        }
      } catch (err) {
        text = msg.text     // never block injection on a correction bug
      }
      this.send({ cmd: 'transform_result', id: msg.id, text })
      if (applied.length) this.emit('corrections', { id: msg.id, applied })
      return
    }

    if (msg.id !== undefined && this._pending.has(msg.id)) {
      const { resolve } = this._pending.get(msg.id)
      this._pending.delete(msg.id)
      resolve(msg)
      return
    }

    this.emit('event', msg)
    if (msg.type) this.emit(msg.type, msg)
  }

  send (msg) {
    if (!this.connected || !this._sock) return false
    try {
      this._sock.write(JSON.stringify(msg) + '\n')
      return true
    } catch (err) {
      return false
    }
  }

  /** Send a command and wait for its reply. */
  request (msg, timeoutMs = 4000) {
    return new Promise((resolve, reject) => {
      if (!this.connected) return reject(new Error('engine not connected'))
      const id = ++this._seq
      this._pending.set(id, { resolve, reject })
      setTimeout(() => {
        if (this._pending.has(id)) {
          this._pending.delete(id)
          reject(new Error('engine did not reply'))
        }
      }, timeoutMs)
      this.send({ ...msg, id })
    })
  }
}

module.exports = { CoreClient }
