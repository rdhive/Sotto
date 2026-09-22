'use strict'

// Main window. No Node here — everything goes through window.sotto.

const api = window.sotto
const $ = (id) => document.getElementById(id)

const el = (tag, cls, text) => {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text !== undefined) n.textContent = text
  return n
}

// Icons are drawn from a fixed set (Feather geometry, one stroke weight) and
// built as DOM, not innerHTML, so no markup string ever reaches the page.
const SVG_NS = 'http://www.w3.org/2000/svg'
const ICONS = {
  copy: [['rect', { x: 9, y: 9, width: 13, height: 13, rx: 2 }],
         ['path', { d: 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1' }]],
  trash: [['polyline', { points: '3 6 5 6 21 6' }],
          ['path', { d: 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2' }]],
  edit: [['path', { d: 'M12 20h9' }],
         ['path', { d: 'M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z' }]],
  arrow: [['line', { x1: 5, y1: 12, x2: 19, y2: 12 }], ['polyline', { points: '12 5 19 12 12 19' }]],
}
function icon (name, size) {
  const s = document.createElementNS(SVG_NS, 'svg')
  for (const [k, v] of Object.entries({
    width: size || 16, height: size || 16, viewBox: '0 0 24 24', fill: 'none',
    stroke: 'currentColor', 'stroke-width': 1.9, 'stroke-linecap': 'round',
    'stroke-linejoin': 'round', 'aria-hidden': 'true',
  })) s.setAttribute(k, v)
  for (const [tag, attrs] of ICONS[name]) {
    const n = document.createElementNS(SVG_NS, tag)
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v)
    s.appendChild(n)
  }
  return s
}
function iconButton (name, label, cls) {
  const b = el('button', 'icon-btn' + (cls ? ' ' + cls : ''))
  b.setAttribute('aria-label', label)
  b.title = label
  b.appendChild(icon(name))
  return b
}

const ui = {
  statusPill: $('statusPill'), statusPillText: $('statusPillText'),
  modelBadge: $('modelBadge'), btnSettings: $('btnSettings'),
  recorder: $('recorder'), btnRecord: $('btnRecord'),
  wave: $('wave'), counter: $('counter'),
  stateLabel: $('stateLabel'), langLabel: $('langLabel'),
  search: $('search'),
  historyList: $('historyList'), historyEmpty: $('historyEmpty'),
  historyEmptyTitle: $('historyEmptyTitle'), historyEmptyHint: $('historyEmptyHint'),
  dictList: $('dictList'), dictEmpty: $('dictEmpty'), dictPath: $('dictPath'),
  dictHeadCount: $('dictHeadCount'), editorTitle: $('editorTitle'),
  entryType: $('entryType'), fieldsCorrection: $('fieldsCorrection'),
  fieldsTerm: $('fieldsTerm'), inFrom: $('inFrom'), inTo: $('inTo'), inTerm: $('inTerm'),
  btnAdd: $('btnAdd'), btnCancelEdit: $('btnCancelEdit'), advice: $('advice'),
  btnOpenFile: $('btnOpenFile'), btnRevealFile: $('btnRevealFile'),
  engineStatus: $('engineStatus'), hotkeyStatus: $('hotkeyStatus'),
  dictCount: $('dictCount'), toast: $('toast'),
}

let view = 'transcriptions'
let engineState = 'offline'
let connected = false
let entryType = 'correction'
let editingId = null
let recordStartedAt = 0

// ==========================================================================
// LEVEL + WAVEFORM
// ==========================================================================
// Audio level events only move a target. Integration and drawing happen once
// per animation frame, so a burst of level messages never causes a re-render.
// The integrated level is sampled into a scrolling waveform, Voice Memos
// style: newest bar on the right, the last take stays visible after stop.

// Live object: re-reading it each frame picks up a light/dark switch.
const css = getComputedStyle(document.documentElement)
const tok = (n) => css.getPropertyValue(n).trim()
const ATTACK = parseFloat(tok('--vu-attack-ms')) || 12
const DECAY = parseFloat(tok('--vu-decay-ms')) || 300
const HOLD = parseFloat(tok('--vu-peak-hold-ms')) || 900
const FALL = parseFloat(tok('--vu-peak-fall-ms')) || 1400
const SAMPLE_MS = parseFloat(tok('--wave-sample-ms')) || 50

let target = 0, needle = 0, peak = 0, peakAt = 0, clock = 0, lastFrame = 0
let sampleClock = 0
let samples = []          // 0..1, oldest first
let waveW = 0, waveH = 0

const BAR_W = 3, BAR_GAP = 2

const ctx = ui.wave.getContext('2d')

function sizeWave () {
  const dpr = window.devicePixelRatio || 1
  const rect = ui.wave.getBoundingClientRect()
  waveW = rect.width; waveH = rect.height
  ui.wave.width = Math.max(1, Math.round(waveW * dpr))
  ui.wave.height = Math.max(1, Math.round(waveH * dpr))
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
}

function drawWave () {
  if (!waveW) return
  ctx.clearRect(0, 0, waveW, waveH)
  const slots = Math.floor((waveW + BAR_GAP) / (BAR_W + BAR_GAP))
  const mid = waveH / 2
  const live = engineState === 'recording'
  const ink = tok('--c-wave')
  const idle = tok('--c-wave-idle')
  const shown = samples.slice(-slots)
  const offset = slots - shown.length

  // Baseline dots for the empty part of the track.
  ctx.fillStyle = idle
  for (let i = 0; i < offset; i++) {
    const x = i * (BAR_W + BAR_GAP)
    ctx.beginPath(); ctx.arc(x + BAR_W / 2, mid, 1, 0, Math.PI * 2); ctx.fill()
  }

  ctx.fillStyle = live ? ink : idle
  for (let i = 0; i < shown.length; i++) {
    // A gentle curve lifts quiet speech without flattening peaks.
    const v = Math.pow(shown[i], 0.7)
    const h = Math.max(2, v * (waveH - 4))
    const x = (offset + i) * (BAR_W + BAR_GAP)
    roundRect(x, mid - h / 2, BAR_W, h, BAR_W / 2)
  }

  // Live playhead at the newest bar.
  if (live) {
    ctx.fillStyle = tok('--c-record')
    const x = Math.min(waveW - 2, (offset + shown.length) * (BAR_W + BAR_GAP) - BAR_GAP)
    ctx.fillRect(x, 4, 1.5, waveH - 8)
  }
}

function roundRect (x, y, w, h, r) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.fill()
}

function fmtElapsed (ms) {
  const s = Math.max(0, ms) / 1000
  const m = Math.floor(s / 60)
  return m + ':' + (s % 60).toFixed(1).padStart(4, '0')
}

function frame (now) {
  const dt = Math.min(64, now - (lastFrame || now))
  lastFrame = now

  // Separate attack and decay constants give the level its weight. A single
  // lerp reads as twitchy.
  const k = target > needle
    ? 1 - Math.exp(-dt / ATTACK)
    : 1 - Math.exp(-dt / DECAY)
  needle += (target - needle) * k

  clock += dt
  if (needle >= peak) { peak = needle; peakAt = clock }
  else if (clock - peakAt > HOLD) peak = Math.max(needle, peak - dt / FALL)

  if (engineState !== 'recording') target = 0

  if (engineState === 'recording') {
    sampleClock += dt
    while (sampleClock >= SAMPLE_MS) {
      sampleClock -= SAMPLE_MS
      samples.push(Math.max(needle, 0.02))
      if (samples.length > 2000) samples.splice(0, samples.length - 2000)
    }
    ui.counter.textContent = fmtElapsed(Date.now() - recordStartedAt)
  }

  drawWave()
  requestAnimationFrame(frame)
}

window.addEventListener('resize', sizeWave)

// ==========================================================================
// STATE
// ==========================================================================
const STATE_LABEL = {
  loading: 'Warming up', idle: 'Ready', recording: 'Recording',
  transcribing: 'Transcribing', polishing: 'Polishing',
  injecting: 'Inserting', error: 'Error', offline: 'Offline',
}
const WORKING = new Set(['transcribing', 'polishing', 'injecting', 'loading'])

function paintPill () {
  let tone = 'offline'
  if (!connected) tone = supervisorError ? 'bad' : 'offline'
  else if (engineState === 'recording') tone = 'recording'
  else if (engineState === 'error') tone = 'bad'
  else if (WORKING.has(engineState)) tone = 'busy'
  else tone = 'ready'
  ui.statusPill.dataset.tone = tone
  ui.statusPillText.textContent = connected
    ? (STATE_LABEL[engineState] || engineState)
    : (supervisorError ? 'Engine stopped' : (supervisorMessage ? 'Starting' : 'Offline'))
}

function setState (state) {
  const was = engineState
  engineState = state

  if (state === 'loading' && !loadingSince) {
    loadingSince = Date.now()
    setTimeout(() => {
      if (engineState === 'loading') {
        ui.engineStatus.textContent =
          'Preparing. The first run downloads the speech model (about 1.6 GB).'
        ui.engineStatus.className = 'status-warn'
      }
    }, 8000)
  }
  if (state !== 'loading') loadingSince = 0
  ui.stateLabel.textContent = STATE_LABEL[state] || state
  ui.recorder.dataset.state = WORKING.has(state) && state !== 'loading' ? 'working' : state

  const rec = state === 'recording'
  ui.btnRecord.disabled = state === 'offline' || state === 'loading'
  const label = rec ? 'Stop dictation' : 'Start dictation'
  ui.btnRecord.setAttribute('aria-label', label)
  ui.btnRecord.title = label

  if (rec && was !== 'recording') {
    recordStartedAt = Date.now()
    peak = 0
    samples = []
    sampleClock = 0
    ui.counter.textContent = fmtElapsed(0)
  }
  if (!rec && was === 'recording') target = 0
  paintPill()
}

// Errors can carry a log tail; the status bar shows the headline and
// keeps the rest in the tooltip.
const firstLine = (text) => String(text).split(String.fromCharCode(10))[0].trim()

let supervisorMessage = null
let supervisorError = null
let loadingSince = 0

function setConnection (isConnected) {
  connected = isConnected
  if (!isConnected) setState('offline')
  paintEngineStatus(isConnected)
  paintPill()
}

function paintEngineStatus (isConnected) {
  // While the engine is starting, the supervisor has more to say than
  // "offline" - and on a first run that wait is minutes, not seconds.
  if (supervisorError) {
    ui.engineStatus.textContent = firstLine(supervisorError)
    ui.engineStatus.className = 'status-bad'
    ui.engineStatus.title = supervisorError
    return
  }
  if (!isConnected && supervisorMessage) {
    ui.engineStatus.textContent = supervisorMessage
    ui.engineStatus.className = 'status-warn'
    ui.engineStatus.title = ''
    return
  }
  ui.engineStatus.textContent = isConnected ? 'Engine connected' : 'Engine offline'
  ui.engineStatus.className = isConnected ? '' : 'status-bad'
  ui.engineStatus.title = ''
}

function toast (message) {
  ui.toast.textContent = message
  ui.toast.hidden = false
  // Restart the entrance animation for back-to-back toasts.
  ui.toast.style.animation = 'none'
  void ui.toast.offsetWidth
  ui.toast.style.animation = ''
  clearTimeout(toast._t)
  toast._t = setTimeout(() => { ui.toast.hidden = true }, 1800)
}

// ==========================================================================
// TRANSCRIPTIONS
// ==========================================================================
function dayKey (d) { return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate() }

function dayLabel (d) {
  const today = new Date()
  const yesterday = new Date(); yesterday.setDate(today.getDate() - 1)
  if (dayKey(d) === dayKey(today)) return 'Today'
  if (dayKey(d) === dayKey(yesterday)) return 'Yesterday'
  const sameYear = d.getFullYear() === today.getFullYear()
  return d.toLocaleDateString([], {
    weekday: 'long', day: 'numeric', month: 'long', year: sameYear ? undefined : 'numeric',
  })
}

function historyRow (entry) {
  const row = el('div', 'row')

  const main = el('div', 'row-main')
  main.appendChild(el('div', 'row-text', entry.text))

  const meta = el('div', 'row-meta')
  const d = new Date(entry.at)
  const parts = [d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })]
  if (entry.language) parts.push(entry.language.toUpperCase())
  if (entry.latencyMs) parts.push(entry.latencyMs + ' ms')
  parts.forEach((p, i) => {
    if (i) meta.appendChild(el('span', 'dot'))
    meta.appendChild(el('span', '', p))
  })

  // Show what the dictionary changed, so it is obvious whether it is
  // earning its keep.
  if (entry.corrections && entry.corrections.length) {
    for (const c of entry.corrections) {
      const f = el('span', 'fix')
      f.title = 'Dictionary correction'
      f.appendChild(el('s', '', c.from))
      f.appendChild(icon('arrow', 11))
      f.appendChild(el('b', '', c.to))
      meta.appendChild(f)
    }
  }
  main.appendChild(meta)
  row.appendChild(main)

  const actions = el('div', 'row-actions')
  const copy = iconButton('copy', 'Copy')
  copy.addEventListener('click', async () => {
    await api.copy(entry.text)
    toast('Copied')
  })
  const del = iconButton('trash', 'Delete', 'danger')
  del.addEventListener('click', async () => {
    await api.history.remove(entry.id)
    renderHistory()
  })
  actions.appendChild(copy)
  actions.appendChild(del)
  row.appendChild(actions)
  return row
}

async function renderHistory () {
  const query = view === 'transcriptions' ? ui.search.value : ''
  const entries = await api.history.list(query)

  const nodes = []
  let currentKey = null, card = null
  for (const entry of entries) {
    const d = new Date(entry.at)
    const key = dayKey(d)
    if (key !== currentKey) {
      currentKey = key
      const head = el('div', 'group-head')
      head.appendChild(el('h2', 'day-title', dayLabel(d)))
      card = el('div', 'card list')
      nodes.push(head, card)
    }
    card.appendChild(historyRow(entry))
  }
  ui.historyList.replaceChildren(...nodes)

  const searching = !!query.trim()
  ui.historyEmptyTitle.textContent = searching ? 'No matches' : 'No transcriptions yet'
  ui.historyEmptyHint.textContent = searching
    ? 'Nothing you have dictated contains "' + query.trim() + '".'
    : 'Hold your push-to-talk key and speak, or press the record button above.'
  ui.historyEmpty.classList.toggle('is-on', entries.length === 0)
}

// ==========================================================================
// DICTIONARY
// ==========================================================================
function dictRow (entry) {
  const row = el('div', 'row dict-row')
  const main = el('div', 'row-main')

  const pair = el('div', 'dict-pair')
  if (entry.type === 'correction') {
    pair.appendChild(el('span', 'dict-from', entry.from))
    pair.appendChild(icon('arrow', 14))
    pair.appendChild(el('span', 'dict-to', entry.to))
  } else {
    pair.appendChild(el('span', 'dict-term', entry.term))
  }
  main.appendChild(pair)
  main.appendChild(el('div', 'dict-kind',
    entry.type === 'correction' ? 'Correction' : 'Word or phrase'))
  row.appendChild(main)

  const actions = el('div', 'row-actions')
  const edit = iconButton('edit', 'Edit')
  edit.addEventListener('click', () => beginEdit(entry))
  const del = iconButton('trash', 'Delete', 'danger')
  del.addEventListener('click', async () => {
    if (editingId === entry.id) endEdit()
    await api.dictionary.remove(entry.id)
    renderDictionary()
  })
  actions.appendChild(edit)
  actions.appendChild(del)
  row.appendChild(actions)
  return row
}

async function renderDictionary () {
  const query = view === 'dictionary' ? ui.search.value : ''
  const entries = await api.dictionary.list(query)
  ui.dictList.replaceChildren(...entries.map(dictRow))
  ui.dictEmpty.classList.toggle('is-on', entries.length === 0)
  ui.dictEmpty.querySelector('h3').textContent =
    query.trim() ? 'No matches' : 'Dictionary is empty'
  ui.dictEmpty.querySelector('p').textContent = query.trim()
    ? 'No entry contains "' + query.trim() + '".'
    : 'Teach it names and jargon it keeps getting wrong.'

  const all = await api.dictionary.list('')
  ui.dictCount.textContent = all.length + (all.length === 1 ? ' entry' : ' entries')
  ui.dictHeadCount.textContent = all.length ? String(all.length) : ''
}

function setEntryType (type) {
  entryType = type
  for (const b of ui.entryType.querySelectorAll('.seg-btn')) {
    b.classList.toggle('is-on', b.dataset.type === type)
  }
  ui.fieldsCorrection.classList.toggle('is-hidden', type !== 'correction')
  ui.fieldsTerm.classList.toggle('is-hidden', type !== 'term')
  checkAdvice()
}

function beginEdit (entry) {
  editingId = entry.id
  setEntryType(entry.type)
  if (entry.type === 'correction') {
    ui.inFrom.value = entry.from
    ui.inTo.value = entry.to
    ui.inFrom.focus()
  } else {
    ui.inTerm.value = entry.term
    ui.inTerm.focus()
  }
  ui.editorTitle.textContent = 'Edit entry'
  ui.btnAdd.textContent = 'Save'
  ui.btnCancelEdit.hidden = false
  checkAdvice()
  ui.inFrom.closest('.scroll').scrollTo({ top: 0, behavior: 'smooth' })
}

function endEdit () {
  editingId = null
  ui.inFrom.value = ''
  ui.inTo.value = ''
  ui.inTerm.value = ''
  ui.editorTitle.textContent = 'Add to dictionary'
  ui.btnAdd.textContent = 'Add'
  ui.btnCancelEdit.hidden = true
  showAdvice(null)
}

function showAdvice (advice) {
  if (!advice) { ui.advice.hidden = true; return }
  ui.advice.hidden = false
  ui.advice.className = 'advice advice-' + advice.level
  ui.advice.textContent = advice.message
}

let adviceTimer = null
function checkAdvice () {
  clearTimeout(adviceTimer)
  if (entryType !== 'correction') { showAdvice(null); return }
  const from = ui.inFrom.value.trim()
  if (!from) { showAdvice(null); return }
  adviceTimer = setTimeout(async () => {
    const risk = await api.dictionary.assess(from)
    if (risk) { showAdvice(risk); return }
    // No warning: say what it will catch, so the glued-word behaviour is
    // visible rather than surprising.
    const parts = from.split(/[\s-]+/).filter(Boolean)
    if (parts.length > 1) {
      showAdvice({
        level: 'ok',
        message: `Also catches "${parts.join('')}" and "${parts.join('-')}".`,
      })
    } else {
      showAdvice({ level: 'ok', message: `Matches "${from}" as a whole word only.` })
    }
  }, 220)
}

async function submitEntry () {
  if (entryType === 'correction') {
    const from = ui.inFrom.value.trim()
    const to = ui.inTo.value.trim()
    if (!from || !to) {
      showAdvice({ level: 'error', message: 'Fill in both what you say and what to write.' })
      ;(from ? ui.inTo : ui.inFrom).focus()
      return
    }
    const risk = await api.dictionary.assess(from)
    if (risk && risk.level === 'error') { showAdvice(risk); return }
    if (editingId) await api.dictionary.update(editingId, { from, to })
    else await api.dictionary.add({ type: 'correction', from, to })
  } else {
    const term = ui.inTerm.value.trim()
    if (!term) {
      showAdvice({ level: 'error', message: 'Enter a word or phrase.' })
      ui.inTerm.focus()
      return
    }
    if (editingId) await api.dictionary.update(editingId, { term })
    else await api.dictionary.add({ type: 'term', term })
  }
  const wasEditing = !!editingId
  endEdit()
  renderDictionary()
  toast(wasEditing ? 'Entry saved' : 'Added to dictionary')
}

// ==========================================================================
// VIEWS
// ==========================================================================
function showView (next) {
  view = next
  for (const t of document.querySelectorAll('.tab')) {
    const on = t.dataset.view === next
    t.classList.toggle('is-active', on)
    t.setAttribute('aria-selected', String(on))
  }
  for (const v of document.querySelectorAll('.view')) {
    v.classList.toggle('is-active', v.id === 'view-' + next)
  }
  ui.search.value = ''
  ui.search.placeholder = next === 'dictionary' ? 'Search dictionary' : 'Search transcriptions'
  renderHistory()
  renderDictionary()
  sizeWave()
}

// ==========================================================================
// WIRING
// ==========================================================================
ui.btnRecord.addEventListener('click', () => {
  if (engineState === 'recording') api.stop()
  else api.start()
})
ui.btnSettings.addEventListener('click', () => api.openSettings())
ui.btnAdd.addEventListener('click', submitEntry)
ui.btnCancelEdit.addEventListener('click', endEdit)
ui.btnOpenFile.addEventListener('click', () => api.dictionary.openFile())
ui.btnRevealFile.addEventListener('click', () => api.dictionary.revealFile())

ui.inFrom.addEventListener('input', checkAdvice)
for (const input of [ui.inFrom, ui.inTo, ui.inTerm]) {
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitEntry()
    if (e.key === 'Escape' && editingId) endEdit()
  })
}

ui.entryType.addEventListener('click', (e) => {
  const btn = e.target.closest('.seg-btn')
  if (btn) setEntryType(btn.dataset.type)
})

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => showView(tab.dataset.view))
}

ui.search.addEventListener('input', () => {
  if (view === 'dictionary') renderDictionary()
  else renderHistory()
})

// Ctrl+F focuses search, as in any list app.
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
    e.preventDefault()
    ui.search.focus()
    ui.search.select()
  }
})

api.onSupervisor((s) => {
  supervisorMessage = s.message
  supervisorError = s.error
  paintEngineStatus(engineState !== 'offline')
  paintPill()
})
api.onState((e) => setState(e.state))
api.onLevel((e) => { target = Math.max(0, Math.min(1, e.value)) })
api.onConnection((e) => setConnection(e.connected))
api.onEmpty(() => toast('Nothing recognised'))
api.onError((e) => toast(e.message || 'Engine error'))
api.onWarning((e) => toast(e.message || 'Warning'))
api.onResult((entry) => {
  renderHistory()
  ui.langLabel.textContent = entry.language ? entry.language.toUpperCase() : ''
  if (entry.corrections && entry.corrections.length) {
    toast(entry.corrections.length + ' correction' +
          (entry.corrections.length === 1 ? '' : 's') + ' applied')
  }
})
api.history.onChanged(() => renderHistory())
api.dictionary.onChanged(() => renderDictionary())
api.onView((e) => showView(e.view))

function paintHotkey (status) {
  if (status.registered) {
    ui.hotkeyStatus.textContent = 'Shortcut ' + prettyAccel(status.accelerator)
    ui.hotkeyStatus.classList.remove('status-bad')
    ui.hotkeyStatus.title = ''
  } else {
    ui.hotkeyStatus.textContent = 'Shortcut unavailable: ' + prettyAccel(status.accelerator) + ' is taken'
    ui.hotkeyStatus.classList.add('status-bad')
    ui.hotkeyStatus.title = status.reason || ''
  }
}
const prettyAccel = (a) => String(a || '').replace('CommandOrControl', 'Ctrl').replace(/\+/g, ' + ')
api.onHotkey(paintHotkey)

// ==========================================================================
// BOOT
// ==========================================================================
async function boot () {
  sizeWave()
  requestAnimationFrame(frame)

  ui.dictPath.textContent = await api.dictionary.filePath()
  ui.dictPath.title = ui.dictPath.textContent

  const sup = await api.supervisor()
  if (sup) { supervisorMessage = sup.message; supervisorError = sup.error }

  const status = await api.status()
  setConnection(status.connected)
  if (status.connected) setState(status.state)

  const hk = await api.getHotkey()
  if (hk) paintHotkey(hk)

  const cfg = await api.getConfig()
  if (cfg) ui.modelBadge.textContent = cfg.stt_model

  setEntryType('correction')
  await renderHistory()
  await renderDictionary()
}

boot()
