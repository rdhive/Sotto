'use strict'

// Floating recording indicator. Same ballistics as the main window's meter,
// driven by the same level events: audio only moves a target value, and
// integration happens once per animation frame.

const api = window.sotto
const unit = document.getElementById('unit')
const label = document.getElementById('label')
const ladder = document.getElementById('ladder')
const counter = document.getElementById('counter')

const css = getComputedStyle(document.documentElement)
const tok = (n) => css.getPropertyValue(n).trim()
const ATTACK = parseFloat(tok('--vu-attack-ms')) || 12
const DECAY = parseFloat(tok('--vu-decay-ms')) || 300
const HOLD = parseFloat(tok('--vu-peak-hold-ms')) || 900
const FALL = parseFloat(tok('--vu-peak-fall-ms')) || 1400

// Must match the body padding in indicator.css, or the window clips the
// drop shadow.
const SHADOW_PAD = 14

const N = 22
const segs = []
for (let i = 0; i < N; i++) {
  const s = document.createElement('i')
  segs.push(s)
  ladder.appendChild(s)
}
// A short scrolling waveform: one bar per sample, newest on the right.
const SAMPLE_MS = parseFloat(tok('--wave-sample-ms')) || 50
const MAX_H = 20
let history = new Array(N).fill(0)
let sampleClock = 0

const WORKING = new Set(['transcribing', 'polishing', 'injecting'])
const LABEL = {
  idle: 'Ready',
  recording: 'Listening',
  transcribing: 'Transcribing',
  polishing: 'Polishing',
  injecting: 'Inserting',
}

let target = 0, needle = 0, peak = 0, peakAt = 0, clock = 0, last = 0
let state = 'idle'
let startedAt = 0

function setState (next) {
  const wasRecording = state === 'recording'
  state = next

  unit.dataset.state = next === 'recording' ? 'recording'
    : WORKING.has(next) ? 'working' : 'idle'
  label.textContent = LABEL[next] || ''

  if (next === 'recording' && !wasRecording) {
    startedAt = Date.now()
    peak = 0
    history = new Array(N).fill(0)
    counter.textContent = '0:00'
  }
  if (next !== 'recording') target = 0
}

function frame (now) {
  const dt = Math.min(64, now - (last || now))
  last = now
  clock += dt

  // Separate attack and decay constants are what give a moving-coil meter
  // its weight. A single lerp reads as twitchy.
  const k = target > needle
    ? 1 - Math.exp(-dt / ATTACK)
    : 1 - Math.exp(-dt / DECAY)
  needle += (target - needle) * k

  if (needle >= peak) { peak = needle; peakAt = clock }
  else if (clock - peakAt > HOLD) peak = Math.max(needle, peak - dt / FALL)

  if (state === 'recording') {
    sampleClock += dt
    while (sampleClock >= SAMPLE_MS) {
      sampleClock -= SAMPLE_MS
      history.push(needle)
      history.shift()
    }
  }
  for (let i = 0; i < N; i++) {
    const v = Math.pow(history[i], 0.7)
    segs[i].style.height = Math.max(3, Math.round(v * MAX_H)) + 'px'
    segs[i].style.opacity = state === 'recording' ? String(0.45 + 0.55 * Math.min(1, v * 1.6)) : '0.3'
  }

  if (state === 'recording') {
    const s = Math.floor((Date.now() - startedAt) / 1000)
    counter.textContent =
      Math.floor(s / 60) + ':' +
      String(s % 60).padStart(2, '0')
  }

  requestAnimationFrame(frame)
}

api.onState((e) => setState(e.state))
api.onLevel((e) => { target = Math.max(0, Math.min(1, e.value)) })

// Tell the main process how big this actually is, rather than hard-coding a
// window size that clips as soon as a label or the font metrics change.
// Fonts must be loaded first — measuring before they land gives fallback
// metrics and a window that is the wrong width.
async function reportSize () {
  try {
    await document.fonts.ready
  } catch (err) {
    // Older engines: measure anyway.
  }
  const r = unit.getBoundingClientRect()
  api.sizeIndicator({
    width: Math.ceil(r.width) + SHADOW_PAD * 2,
    height: Math.ceil(r.height) + SHADOW_PAD * 2,
  })
}

reportSize()
requestAnimationFrame(() => {
  unit.classList.add('visible')
  requestAnimationFrame(frame)
})
