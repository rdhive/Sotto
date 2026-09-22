'use strict'

// Transcription history, kept in the main process next to the dictionary.
// Capped, because this file grows for as long as the app is used.

const fs = require('fs')
const path = require('path')

const FILE = 'history.json'
const MAX_ENTRIES = 1000

class History {
  constructor (userDataPath) {
    this.path = path.join(userDataPath, FILE)
    this.entries = []
    this._saveTimer = null
    this.load()
  }

  load () {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.path, 'utf8'))
      this.entries = Array.isArray(parsed) ? parsed : (parsed.entries || [])
    } catch (err) {
      this.entries = []
    }
    return this.entries
  }

  add (entry) {
    const row = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      at: new Date().toISOString(),
      text: entry.text || '',
      raw: entry.raw || '',
      language: entry.language || null,
      latencyMs: entry.latencyMs || null,
      durationMs: entry.durationMs || null,
      // What the dictionary changed, so it is visible whether it did anything.
      corrections: entry.corrections || [],
    }
    this.entries.unshift(row)
    if (this.entries.length > MAX_ENTRIES) this.entries.length = MAX_ENTRIES
    this._queueSave()
    return row
  }

  remove (id) {
    const i = this.entries.findIndex(e => e.id === id)
    if (i === -1) return false
    this.entries.splice(i, 1)
    this._queueSave()
    return true
  }

  clear () {
    this.entries = []
    this._queueSave()
  }

  search (query) {
    const q = String(query || '').trim().toLowerCase()
    if (!q) return this.entries
    return this.entries.filter(e =>
      String(e.text).toLowerCase().includes(q) ||
      String(e.raw).toLowerCase().includes(q)
    )
  }

  _queueSave () {
    clearTimeout(this._saveTimer)
    this._saveTimer = setTimeout(() => this.flush(), 500)
  }

  flush () {
    clearTimeout(this._saveTimer)
    try {
      fs.mkdirSync(path.dirname(this.path), { recursive: true })
      const tmp = this.path + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify({ entries: this.entries }, null, 2), 'utf8')
      fs.renameSync(tmp, this.path)
    } catch (err) {
      // Losing history is not worth crashing over.
    }
  }
}

module.exports = { History }
