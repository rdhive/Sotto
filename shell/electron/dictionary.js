'use strict'

// Dictionary store + correction engine. Main process only — the renderer
// reaches this through the preload bridge and never touches disk itself.
//
// Two entry types:
//   term        a word or phrase the engine should know exists. Feeds the
//               bias list only; there is nothing to rewrite.
//   correction  "when you hear X, write Y". Feeds the bias list (the Y side)
//               and the post-transcription rewrite (the X side).
//
// Biasing is a nudge. The rewrite is the guarantee. Both are needed.

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { EventEmitter } = require('events')

const FILE = 'dictionary.json'
const VERSION = 1

// Whisper drifts and starts inventing text on quiet audio when the prompt
// gets long, so the bias list is deliberately capped.
const BIAS_MAX_TERMS = 40
const BIAS_MAX_CHARS = 320

// Words common enough that rewriting every occurrence would be a mistake.
// Not exhaustive — it only has to catch the obvious foot-guns.
const COMMON_WORDS = new Set([
  // en
  'the', 'and', 'for', 'you', 'are', 'was', 'this', 'that', 'with', 'from',
  'have', 'has', 'not', 'but', 'all', 'can', 'will', 'one', 'out', 'get',
  'code', 'cloud', 'test', 'file', 'work', 'time', 'name', 'note', 'call',
  'read', 'send', 'open', 'make', 'take', 'like', 'need', 'want', 'know',
  'good', 'new', 'now', 'here', 'there', 'what', 'when', 'then', 'they',
  'some', 'more', 'most', 'over', 'back', 'down', 'just', 'also', 'about',
  // fr
  'le', 'la', 'les', 'des', 'une', 'est', 'pour', 'dans', 'que', 'qui',
  'avec', 'sur', 'pas', 'plus', 'mais', 'tout', 'faire', 'dire', 'cette',
  'nous', 'vous', 'bien', 'donc', 'alors', 'code', 'fichier', 'temps',
  // nl
  'de', 'het', 'een', 'van', 'en', 'is', 'dat', 'die', 'niet', 'voor',
  'met', 'aan', 'ook', 'maar', 'naar', 'zijn', 'heeft', 'worden', 'kunnen',
])

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex')
const nowIso = () => new Date().toISOString()

function newId () {
  return crypto.randomBytes(8).toString('hex')
}

// --- pattern construction -------------------------------------------------

const RE_SPECIAL = /[.*+?^${}()|[\]\\]/g
const escapeRe = (s) => s.replace(RE_SPECIAL, '\\$&')

/**
 * Build the match pattern for the spoken side of a correction.
 *
 * Speech models glue multi-word names together unpredictably: "cloud code"
 * comes back as "cloudcode" or "cloud-code" as often as the spaced form. So
 * the separator between parts is optional whitespace or a hyphen.
 *
 * The leading and trailing \b are what keep this safe. "cloud code" compiles
 * to /\bcloud[\s-]*code\b/i, which matches "CloudCode" and "cloud-code" but
 * cannot touch "Cloudflare" (no "code" follows), the bare word "cloud", or
 * "cloud coder" (no boundary after "code").
 */
function buildPattern (from) {
  const parts = String(from).trim().split(/[\s-]+/).filter(Boolean)
  if (!parts.length) return null
  const body = parts.map(escapeRe).join('[\\s-]*')
  // \b only works next to a word character. If an entry starts or ends with
  // punctuation, anchor on a non-word-char lookaround instead.
  const head = /^[\wÀ-ɏ]/.test(parts[0]) ? '\\b' : '(?<![\\w\\u00C0-\\u024F])'
  const tailChar = parts[parts.length - 1].slice(-1)
  const tail = /[\wÀ-ɏ]/.test(tailChar) ? '\\b' : '(?![\\w\\u00C0-\\u024F])'
  return head + body + tail
}

/**
 * Would this entry rewrite ordinary speech?
 * Returns null when fine, or { level, message } to show in the UI.
 */
function assessRisk (from) {
  const raw = String(from || '').trim()
  if (!raw) return { level: 'error', message: 'Enter the word to listen for.' }

  const parts = raw.split(/[\s-]+/).filter(Boolean)
  const lower = raw.toLowerCase()

  if (parts.length === 1) {
    if (lower.length <= 2) {
      return {
        level: 'error',
        message: `"${raw}" is too short — it would fire constantly.`,
      }
    }
    if (COMMON_WORDS.has(lower)) {
      return {
        level: 'warn',
        message: `"${raw}" is an ordinary word. Every time you say it, ` +
                 `it will be rewritten. Add a second word to make it specific.`,
      }
    }
    if (lower.length <= 3) {
      return {
        level: 'warn',
        message: `"${raw}" is very short and may match more than you expect.`,
      }
    }
  }
  return null
}

// --- store ----------------------------------------------------------------

class Dictionary extends EventEmitter {
  constructor (userDataPath) {
    super()
    this.path = path.join(userDataPath, FILE)
    this.entries = []
    this._diskHash = null
    this._watcher = null
    this._debounce = null
    this._writing = false
    this._rules = null
  }

  // -- disk ---------------------------------------------------------------
  load () {
    let raw
    try {
      raw = fs.readFileSync(this.path)
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
      this.entries = []
      this._persist(this.entries)
      return this.entries
    }

    this._diskHash = sha(raw)
    let parsed
    try {
      parsed = JSON.parse(raw.toString('utf8'))
    } catch (err) {
      // A hand edit broke the JSON. Keep the file — never silently discard
      // someone's typing — and report it instead.
      this.emit('error', new Error(
        `dictionary.json is not valid JSON (${err.message}). ` +
        'Fix it in the editor; nothing was overwritten.'
      ))
      return this.entries
    }

    this.entries = Array.isArray(parsed) ? parsed : (parsed.entries || [])
    this.entries = this.entries.filter(e => e && (e.type === 'term' || e.type === 'correction'))
    this._rules = null
    return this.entries
  }

  /**
   * Every mutation re-reads from disk first, so a hand edit made while the
   * app was open can never be clobbered by a stale in-memory copy.
   */
  mutate (fn) {
    this.load()
    const result = fn(this.entries)
    this._persist(this.entries)
    this._rules = null
    this.emit('changed', this.entries)
    return result
  }

  _persist (entries) {
    const body = JSON.stringify(
      { version: VERSION, updatedAt: nowIso(), entries }, null, 2
    )
    this._writing = true
    fs.mkdirSync(path.dirname(this.path), { recursive: true })
    // Write-then-rename so a crash mid-write cannot truncate the file.
    const tmp = this.path + '.tmp'
    fs.writeFileSync(tmp, body, 'utf8')
    fs.renameSync(tmp, this.path)
    this._diskHash = sha(Buffer.from(body, 'utf8'))
    setTimeout(() => { this._writing = false }, 150)
  }

  watch () {
    const arm = () => {
      try {
        this._watcher = fs.watch(this.path, () => this._onFsEvent())
        this._watcher.on('error', () => this._rearm())
      } catch (err) {
        // File may not exist yet, or an editor replaced it. Try again shortly.
        setTimeout(arm, 500)
      }
    }
    this._rearm = () => {
      if (this._watcher) { try { this._watcher.close() } catch (e) {} }
      this._watcher = null
      setTimeout(arm, 200)
    }
    arm()
  }

  _onFsEvent () {
    // Our own write triggers the watcher; ignore that window.
    if (this._writing) return
    clearTimeout(this._debounce)
    this._debounce = setTimeout(() => {
      let raw
      try {
        raw = fs.readFileSync(this.path)
      } catch (err) {
        this._rearm()
        return
      }
      if (sha(raw) === this._diskHash) return   // content identical, ignore
      this.load()
      this.emit('changed', this.entries)
      this.emit('external-change')
      // Editors that save by replace break the watch handle.
      this._rearm()
    }, 140)
  }

  unwatch () {
    clearTimeout(this._debounce)
    if (this._watcher) { try { this._watcher.close() } catch (e) {} }
    this._watcher = null
  }

  // -- editing ------------------------------------------------------------
  add (entry) {
    return this.mutate((entries) => {
      const row = {
        id: newId(),
        type: entry.type === 'correction' ? 'correction' : 'term',
        createdAt: nowIso(),
        updatedAt: nowIso(),
      }
      if (row.type === 'correction') {
        row.from = String(entry.from || '').trim()
        row.to = String(entry.to || '').trim()
      } else {
        row.term = String(entry.term || '').trim()
      }
      entries.push(row)
      return row
    })
  }

  update (id, patch) {
    return this.mutate((entries) => {
      const row = entries.find(e => e.id === id)
      if (!row) return null
      for (const k of ['term', 'from', 'to']) {
        if (patch[k] !== undefined) row[k] = String(patch[k]).trim()
      }
      row.updatedAt = nowIso()
      return row
    })
  }

  remove (id) {
    return this.mutate((entries) => {
      const i = entries.findIndex(e => e.id === id)
      if (i === -1) return false
      entries.splice(i, 1)
      return true
    })
  }

  search (query) {
    const q = String(query || '').trim().toLowerCase()
    if (!q) return this.entries
    return this.entries.filter(e => {
      const hay = e.type === 'correction' ? `${e.from} ${e.to}` : e.term
      return String(hay).toLowerCase().includes(q)
    })
  }

  // -- biasing ------------------------------------------------------------
  /**
   * Terms handed to the speech engine as context so it leans toward
   * producing them. Capped: a long prompt makes Whisper drift and
   * hallucinate on quiet audio.
   */
  biasTerms () {
    const seen = new Set()
    const out = []
    // Most recently touched first — those are the ones being worked on.
    const ordered = [...this.entries].sort(
      (a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))
    )
    for (const e of ordered) {
      const term = e.type === 'correction' ? e.to : e.term
      if (!term) continue
      const key = term.toLowerCase()
      if (seen.has(key)) continue
      const projected = out.join(', ').length + term.length + 2
      if (out.length >= BIAS_MAX_TERMS || projected > BIAS_MAX_CHARS) break
      seen.add(key)
      out.push(term)
    }
    return out
  }

  // -- correction pass ----------------------------------------------------
  rules () {
    if (this._rules) return this._rules
    this._rules = this.entries
      .filter(e => e.type === 'correction' && e.from && e.to)
      .map(e => {
        const source = buildPattern(e.from)
        if (!source) return null
        return { id: e.id, from: e.from, to: e.to, source, re: new RegExp(source, 'i') }
      })
      .filter(Boolean)
      // Longest first so "cloud code studio" wins over "cloud code".
      .sort((a, b) => b.from.length - a.from.length)
    return this._rules
  }

  /**
   * Apply corrections. Returns the new text plus what fired, so the history
   * can show whether the dictionary actually did anything.
   */
  apply (text) {
    const rules = this.rules()
    if (!text || !rules.length) return { text: text || '', applied: [] }

    // One combined pass. Alternatives are already longest-first, and the
    // regex engine prefers the earliest alternative that matches, so longer
    // entries win and matches cannot overlap.
    const combined = new RegExp(rules.map(r => `(?:${r.source})`).join('|'), 'gi')
    const applied = []

    const out = text.replace(combined, (match, ...rest) => {
      const offset = rest[rest.length - 2]
      const rule = rules.find(r => new RegExp(`^(?:${r.source})$`, 'i').test(match))
      if (!rule) return match
      if (match === rule.to) return match          // already correct
      applied.push({ id: rule.id, from: match, to: rule.to, at: offset })
      return rule.to
    })

    return { text: out, applied }
  }
}

module.exports = { Dictionary, buildPattern, assessRisk, COMMON_WORDS }
