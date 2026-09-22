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

const ui = {
  lampRec: $('lampRec'), lampLink: $('lampLink'), modelBadge: $('modelBadge'),
  btnRecord: $('btnRecord'), btnStop: $('btnStop'),
  vu: $('vu'), ladder: $('ladder'), counter: $('counter'),
  stateLabel: $('stateLabel'), langLabel: $('langLabel'),
  search: $('search'),
  historyList: $('historyList'), historyEmpty: $('historyEmpty'),
  dictList: $('dictList'), dictEmpty: $('dictEmpty'), dictPath: $('dictPath'),
  entryType: $('entryType'), fieldsCorrection: $('fieldsCorrection'),
  fieldsTerm: $('fieldsTerm'), inFrom: $('inFrom'), inTo: $('inTo'), inTerm: $('inTerm'),
  btnAdd: $('btnAdd'), btnCancelEdit: $('btnCancelEdit'), advice: $('advice'),
  btnOpenFile: $('btnOpenFile'), btnRevealFile: $('btnRevealFile'),
  engineStatus: $('engineStatus'), hotkeyStatus: $('hotkeyStatus'),
  dictCount: $('dictCount'), toast: $('toast'),
}

let view = 'transcriptions'
let engineState = 'offline'
let entryType = 'correction'
let editingId = null
let recordStartedAt = 0

// ==========================================================================
// METERS
// ==========================================================================
// Audio level events only move a target. Integration and drawing happen once
// per animation frame, so a burst of level messages never causes a re-render.

const css = getComputedStyle(document.documentElement)
const tok = (n) => css.getPropertyValue(n).trim()
const ATTACK = parseFloat(tok('--vu-attack-ms')) || 12
const DECAY = parseFloat(tok('--vu-decay-ms')) || 300
const HOLD = parseFloat(tok('--vu-peak-hold-ms')) || 900
const FALL = parseFloat(tok('--vu-peak-fall-ms')) || 1400

let target = 0, needle = 0, peak = 0, peakAt = 0, clock = 0, lastFrame = 0

const LADDER_N = 28
const segs = []
for (let i = 0; i < LADDER_N; i++) {
  const s = el('i')
  segs.push(s)
  ui.ladder.appendChild(s)
}
function segColour (i) {
  const v = i / (LADDER_N - 1)
  if (v > 0.86) return tok('--c-vu-peak')
  if (v > 0.72) return tok('--c-vu-amber')
  return tok('--c-vu-green')
}

const ctx = ui.vu.getContext('2d')
let vuW = 0, vuH = 0

function sizeVu () {
  const dpr = window.devicePixelRatio || 1
  const rect = ui.vu.getBoundingClientRect()
  vuW = rect.width; vuH = rect.height
  ui.vu.width = Math.max(1, Math.round(vuW * dpr))
  ui.vu.height = Math.max(1, Math.round(vuH * dpr))
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
}

function drawVu () {
  if (!vuW) return
  const pad = 10
  ctx.clearRect(0, 0, vuW, vuH)

  ctx.fillStyle = tok('--c-vu-face')
  ctx.fillRect(0, 0, vuW, vuH)
  const g = ctx.createLinearGradient(0, 0, 0, vuH)
  g.addColorStop(0, 'rgba(0,0,0,0.10)')
  g.addColorStop(0.35, 'rgba(0,0,0,0)')
  g.addColorStop(1, 'rgba(0,0,0,0.16)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, vuW, vuH)

  const cx = vuW / 2, cy = vuH + 46, R = vuH + 18
  const A0 = -Math.PI * 0.80, A1 = -Math.PI * 0.20
  const ang = (v) => A0 + (A1 - A0) * Math.max(0, Math.min(1, v))

  ctx.lineWidth = 1.4
  ctx.strokeStyle = tok('--c-vu-ink')
  ctx.beginPath(); ctx.arc(cx, cy, R - pad, A0, A1); ctx.stroke()

  ctx.lineWidth = 3.5
  ctx.strokeStyle = tok('--c-vu-peak')
  ctx.beginPath(); ctx.arc(cx, cy, R - pad - 4, ang(0.72), A1); ctx.stroke()

  ctx.font = '600 8px ' + tok('--font-legend')
  ctx.textAlign = 'center'
  ctx.fillStyle = tok('--c-vu-ink')
  for (const [v, label] of [[0, '-20'], [0.2, '-10'], [0.42, '-5'],
                            [0.58, '-3'], [0.72, '0'], [0.87, '+3'], [1, '+6']]) {
    const a = ang(v), sx = Math.cos(a), sy = Math.sin(a)
    ctx.lineWidth = 1.4
    ctx.strokeStyle = tok('--c-vu-ink')
    ctx.beginPath()
    ctx.moveTo(cx + sx * (R - pad), cy + sy * (R - pad))
    ctx.lineTo(cx + sx * (R - pad - 7), cy + sy * (R - pad - 7))
    ctx.stroke()
    ctx.fillText(label, cx + sx * (R - pad - 16), cy + sy * (R - pad - 16) + 3)
  }
  ctx.font = '600 7px ' + tok('--font-legend')
  ctx.fillText('V U', cx, cy - R + 52)

  const pa = ang(peak)
  ctx.strokeStyle = tok('--c-vu-peak')
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(cx + Math.cos(pa) * (R - pad - 1), cy + Math.sin(pa) * (R - pad - 1))
  ctx.lineTo(cx + Math.cos(pa) * (R - pad - 7), cy + Math.sin(pa) * (R - pad - 7))
  ctx.stroke()

  const na = ang(needle)
  ctx.strokeStyle = 'rgba(0,0,0,0.15)'
  ctx.lineWidth = 3
  ctx.lineCap = 'round'
  ctx.beginPath()
  ctx.moveTo(cx + 2, cy + 2)
  ctx.lineTo(cx + Math.cos(na) * (R - pad - 11) + 2, cy + Math.sin(na) * (R - pad - 11) + 2)
  ctx.stroke()
  ctx.strokeStyle = tok('--c-vu-needle')
  ctx.lineWidth = 1.8
  ctx.beginPath()
  ctx.moveTo(cx, cy)
  ctx.lineTo(cx + Math.cos(na) * (R - pad - 11), cy + Math.sin(na) * (R - pad - 11))
  ctx.stroke()
}

function drawLadder () {
  const lit = Math.round(needle * LADDER_N)
  const peakSeg = Math.round(peak * LADDER_N)
  for (let i = 0; i < LADDER_N; i++) {
    const on = i < lit || i === peakSeg - 1
    const c = segColour(i)
    segs[i].style.background = on ? c : tok('--c-led-off')
    segs[i].style.boxShadow = on
      ? '0 0 3px ' + c + ', inset 0 1px 1px rgba(0,0,0,.35)'
      : 'inset 0 1px 1px rgba(0,0,0,.6)'
  }
}

function frame (now) {
  const dt = Math.min(64, now - (lastFrame || now))
  lastFrame = now

  // Separate attack and decay constants are what give a moving-coil meter
  // its weight. A single lerp reads as twitchy.
  const k = target > needle
    ? 1 - Math.exp(-dt / ATTACK)
    : 1 - Math.exp(-dt / DECAY)
  needle += (target - needle) * k

  clock += dt
  if (needle >= peak) { peak = needle; peakAt = clock }
  else if (clock - peakAt > HOLD) peak = Math.max(needle, peak - dt / FALL)

  if (engineState !== 'recording') target = 0

  drawVu()
  drawLadder()

  if (engineState === 'recording') {
    const s = (Date.now() - recordStartedAt) / 1000
    ui.counter.textContent =
      String(Math.floor(s / 60)).padStart(2, '0') + ':' +
      (s % 60).toFixed(1).padStart(4, '0')
  }
  requestAnimationFrame(frame)
}

window.addEventListener('resize', sizeVu)

// ==========================================================================
// STATE
// ==========================================================================
const STATE_LABEL = {
  loading: 'Warming up', idle: 'Ready', recording: 'Recording',
  transcribing: 'Transcribing', polishing: 'Polishing',
  injecting: 'Inserting', error: 'Error', offline: 'Offline',
}

function setState (state) {
  const was = engineState
  engineState = state

  if (state === 'loading' && !loadingSince) {
    loadingSince = Date.now()
    setTimeout(() => {
      if (engineState === 'loading') {
        ui.engineStatus.textContent =
          'Preparing — first run downloads the speech model (about 1.6 GB)'
        ui.engineStatus.className = 'legend status-warn'
      }
    }, 8000)
  }
  if (state !== 'loading') loadingSince = 0
  ui.stateLabel.textContent = STATE_LABEL[state] || state

  const rec = state === 'recording'
  ui.lampRec.classList.toggle('on', rec)
  ui.btnRecord.classList.toggle('is-armed', rec)
  ui.btnRecord.disabled = rec || state === 'offline' || state === 'loading'
  ui.btnStop.disabled = !rec

  if (rec && was !== 'recording') {
    recordStartedAt = Date.now()
    peak = 0
  }
  if (!rec && was === 'recording') target = 0
}

// Errors can carry a log tail; the status bar shows the headline and
// keeps the rest in the tooltip.
const firstLine = (text) => String(text).split(String.fromCharCode(10))[0].trim()

let supervisorMessage = null
let supervisorError = null
let loadingSince = 0

function setConnection (connected) {
  ui.lampLink.classList.toggle('on', connected)
  if (!connected) setState('offline')
  paintEngineStatus(connected)
}

function paintEngineStatus (connected) {
  // While the engine is starting, the supervisor has more to say than
  // "offline" - and on a first run that wait is minutes, not seconds.
  if (supervisorError) {
    ui.engineStatus.textContent = firstLine(supervisorError)
    ui.engineStatus.className = 'legend status-bad'
    ui.engineStatus.title = supervisorError
    return
  }
  if (!connected && supervisorMessage) {
    ui.engineStatus.textContent = supervisorMessage
    ui.engineStatus.className = 'legend status-warn'
    ui.engineStatus.title = ''
    return
  }
  ui.engineStatus.textContent = connected ? 'Engine connected' : 'Engine offline'
  ui.engineStatus.className = 'legend' + (connected ? '' : ' status-bad')
  ui.engineStatus.title = ''
}

function toast (message) {
  ui.toast.textContent = message
  ui.toast.hidden = false
  clearTimeout(toast._t)
  toast._t = setTimeout(() => { ui.toast.hidden = true }, 1600)
}

// ==========================================================================
// TRANSCRIPTIONS
// ==========================================================================
function timeLabel (iso) {
  const d = new Date(iso)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) +
         ' · ' + d.toLocaleDateString([], { day: '2-digit', month: 'short' })
}

function historyRow (entry) {
  const row = el('div', 'row')

  const main = el('div')
  main.appendChild(el('div', 'row-text', entry.text))

  const meta = el('div', 'row-meta')
  meta.appendChild(el('span', 'badge', timeLabel(entry.at)))
  if (entry.language) meta.appendChild(el('span', 'badge', entry.language))
  if (entry.latencyMs) meta.appendChild(el('span', 'badge', entry.latencyMs + ' ms'))

  // Show what the dictionary changed, so it is obvious whether it is
  // earning its keep.
  if (entry.corrections && entry.corrections.length) {
    meta.appendChild(el('span', 'badge badge-fix',
      entry.corrections.length + (entry.corrections.length === 1 ? ' fix' : ' fixes')))
    for (const c of entry.corrections) {
      const d = el('span', 'fix-detail')
      const from = el('s'); from.textContent = c.from
      const to = el('b'); to.textContent = c.to
      d.appendChild(from)
      d.appendChild(document.createTextNode(' → '))
      d.appendChild(to)
      meta.appendChild(d)
    }
  }
  main.appendChild(meta)
  row.appendChild(main)

  const actions = el('div', 'row-actions')
  const copy = el('button', 'key key-quiet', 'Copy')
  copy.addEventListener('click', async () => {
    await api.copy(entry.text)
    toast('Copied')
  })
  const del = el('button', 'key key-quiet', 'Delete')
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
  ui.historyList.replaceChildren(...entries.map(historyRow))
  ui.historyEmpty.classList.toggle('is-on', entries.length === 0)
}

// ==========================================================================
// DICTIONARY
// ==========================================================================
function dictRow (entry) {
  const row = el('div', 'row')
  const main = el('div')

  if (entry.type === 'correction') {
    const pair = el('div', 'dict-pair')
    pair.appendChild(el('span', 'legend', 'Hear'))
    pair.appendChild(el('span', 'dict-from', entry.from))
    pair.appendChild(el('span', 'legend', 'Write'))
    pair.appendChild(el('span', 'dict-to', entry.to))
    main.appendChild(pair)
  } else {
    const pair = el('div', 'dict-pair')
    pair.appendChild(el('span', 'legend', 'Knows'))
    pair.appendChild(el('span', 'dict-term', entry.term))
    main.appendChild(pair)
  }
  row.appendChild(main)

  const actions = el('div', 'row-actions')
  const edit = el('button', 'key key-quiet', 'Edit')
  edit.addEventListener('click', () => beginEdit(entry))
  const del = el('button', 'key key-quiet', 'Delete')
  del.addEventListener('click', async () => {
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

  const all = await api.dictionary.list('')
  ui.dictCount.textContent = all.length + (all.length === 1 ? ' entry' : ' entries')
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
  ui.btnAdd.textContent = 'Save'
  ui.btnCancelEdit.hidden = false
}

function endEdit () {
  editingId = null
  ui.inFrom.value = ''
  ui.inTo.value = ''
  ui.inTerm.value = ''
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
        message: `Will also catch "${parts.join('')}" and "${parts.join('-')}".`,
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
    if (!from || !to) { toast('Both fields are required'); return }
    const risk = await api.dictionary.assess(from)
    if (risk && risk.level === 'error') { showAdvice(risk); return }
    if (editingId) await api.dictionary.update(editingId, { from, to })
    else await api.dictionary.add({ type: 'correction', from, to })
  } else {
    const term = ui.inTerm.value.trim()
    if (!term) { toast('Enter a word or phrase'); return }
    if (editingId) await api.dictionary.update(editingId, { term })
    else await api.dictionary.add({ type: 'term', term })
  }
  endEdit()
  renderDictionary()
  toast('Dictionary updated')
}

// ==========================================================================
// VIEWS
// ==========================================================================
function showView (next) {
  view = next
  for (const t of document.querySelectorAll('.tab')) {
    t.classList.toggle('is-active', t.dataset.view === next)
  }
  for (const v of document.querySelectorAll('.view')) {
    v.classList.toggle('is-active', v.id === 'view-' + next)
  }
  ui.search.value = ''
  ui.search.placeholder = next === 'dictionary' ? 'Search dictionary' : 'Search transcriptions'
  renderHistory()
  renderDictionary()
  sizeVu()
}

// ==========================================================================
// WIRING
// ==========================================================================
ui.btnRecord.addEventListener('click', () => api.start())
ui.btnStop.addEventListener('click', () => api.stop())
ui.btnAdd.addEventListener('click', submitEntry)
ui.btnCancelEdit.addEventListener('click', endEdit)
ui.btnOpenFile.addEventListener('click', () => api.dictionary.openFile())
ui.btnRevealFile.addEventListener('click', () => api.dictionary.revealFile())

ui.inFrom.addEventListener('input', checkAdvice)
for (const input of [ui.inFrom, ui.inTo, ui.inTerm]) {
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitEntry() })
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

api.onSupervisor((s) => {
  supervisorMessage = s.message
  supervisorError = s.error
  paintEngineStatus(engineState !== 'offline')
})
api.onState((e) => setState(e.state))
api.onLevel((e) => { target = Math.max(0, Math.min(1, e.value)) })
api.onConnection((e) => setConnection(e.connected))
api.onEmpty(() => toast('Nothing recognised'))
api.onError((e) => toast(e.message || 'Engine error'))
api.onWarning((e) => toast(e.message || 'Warning'))
api.onResult((entry) => {
  renderHistory()
  ui.langLabel.textContent = entry.language || ''
  if (entry.corrections && entry.corrections.length) {
    toast(entry.corrections.length + ' correction' +
          (entry.corrections.length === 1 ? '' : 's') + ' applied')
  }
})
api.history.onChanged(() => renderHistory())
api.dictionary.onChanged(() => renderDictionary())
api.onView((e) => showView(e.view))

api.onHotkey((status) => {
  if (status.registered) {
    ui.hotkeyStatus.textContent = 'Shortcut ' + status.accelerator
    ui.hotkeyStatus.classList.remove('status-bad')
    ui.hotkeyStatus.title = ''
  } else {
    ui.hotkeyStatus.textContent = 'Shortcut unavailable — ' + status.accelerator + ' is taken'
    ui.hotkeyStatus.classList.add('status-bad')
    ui.hotkeyStatus.title = status.reason || ''
  }
})

// ==========================================================================
// BOOT
// ==========================================================================
async function boot () {
  sizeVu()
  requestAnimationFrame(frame)

  ui.dictPath.textContent = await api.dictionary.filePath()

  const sup = await api.supervisor()
  if (sup) { supervisorMessage = sup.message; supervisorError = sup.error }

  const status = await api.status()
  setConnection(status.connected)
  if (status.connected) setState(status.state)

  const hk = await api.getHotkey()
  if (hk) {
    ui.hotkeyStatus.textContent = hk.registered
      ? 'Shortcut ' + hk.accelerator
      : 'Shortcut unavailable — ' + hk.accelerator + ' is taken'
    ui.hotkeyStatus.classList.toggle('status-bad', !hk.registered)
  }

  const cfg = await api.getConfig()
  if (cfg) ui.modelBadge.textContent = cfg.stt_model

  setEntryType('correction')
  await renderHistory()
  await renderDictionary()
}

boot()
