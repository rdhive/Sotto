'use strict'

const api = window.sotto
const $ = (id) => document.getElementById(id)

const ui = {
  btnCapture: $('btnCapture'), btnResetHotkey: $('btnResetHotkey'),
  hotkeyAdvice: $('hotkeyAdvice'),
  btnPtt: $('btnPtt'), pttAdvice: $('pttAdvice'),
  selStt: $('selStt'), selLang: $('selLang'),
  selPolish: $('selPolish'), inPolishModel: $('inPolishModel'),
  selDevice: $('selDevice'),
  saveAdvice: $('saveAdvice'), settingsStatus: $('settingsStatus'),
  btnClose: $('btnClose'),
}

const DEFAULT_ACCELERATOR = 'CommandOrControl+Shift+D'

// Push-to-talk has to be a key that is not used for typing, because the
// engine swallows it while bound. KeyboardEvent.code -> Windows virtual-key.
const PTT_KEYS = {
  CapsLock: [0x14, 'Caps Lock'],
  ControlRight: [0xA3, 'Right Ctrl'],
  ControlLeft: [0xA2, 'Left Ctrl'],
  ShiftRight: [0xA1, 'Right Shift'],
  ShiftLeft: [0xA0, 'Left Shift'],
  ContextMenu: [0x5D, 'Menu'],
  ScrollLock: [0x91, 'Scroll Lock'],
  Pause: [0x13, 'Pause'],
}
for (let i = 0; i < 12; i++) PTT_KEYS['F' + (13 + i)] = [0x7C + i, 'F' + (13 + i)]

const VK_NAMES = {}
for (const [, [vk, label]] of Object.entries(PTT_KEYS)) VK_NAMES[vk] = label

function advise (node, level, message) {
  if (!message) { node.hidden = true; return }
  node.hidden = false
  node.className = 'advice advice-' + level
  node.textContent = message
}

function status (message) {
  ui.settingsStatus.textContent = message
  clearTimeout(status._t)
  status._t = setTimeout(() => { ui.settingsStatus.textContent = '' }, 2200)
}

// ---- global accelerator capture -----------------------------------------
let capturing = false

function acceleratorFrom (e) {
  const parts = []
  if (e.ctrlKey) parts.push('CommandOrControl')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  if (e.metaKey) parts.push('Super')

  const code = e.code
  let key = null
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3)
  else if (/^Digit\d$/.test(code)) key = code.slice(5)
  else if (/^F\d{1,2}$/.test(code)) key = code
  else if (code === 'Space') key = 'Space'
  else if (code === 'Backquote') key = '`'

  if (!key) return null
  // A bare letter is not a usable global shortcut — it would swallow that
  // key everywhere on the system.
  if (!parts.length) return null
  parts.push(key)
  return parts.join('+')
}

ui.btnCapture.addEventListener('click', () => {
  capturing = true
  ui.btnCapture.classList.add('is-listening')
  ui.btnCapture.textContent = 'Press a combination…'
  advise(ui.hotkeyAdvice, 'ok', 'Include Ctrl, Alt or Shift. Esc to cancel.')
})

ui.btnResetHotkey.addEventListener('click', () => applyAccelerator(DEFAULT_ACCELERATOR))

async function applyAccelerator (accelerator) {
  const result = await api.setHotkey(accelerator)
  ui.btnCapture.textContent = result.accelerator
  if (result.registered) {
    advise(ui.hotkeyAdvice, 'ok', 'Registered with Windows.')
  } else {
    advise(ui.hotkeyAdvice, 'error', result.reason || 'Could not register.')
  }
}

// ---- push-to-talk capture ------------------------------------------------
let capturingPtt = false

ui.btnPtt.addEventListener('click', () => {
  capturingPtt = true
  ui.btnPtt.classList.add('is-listening')
  ui.btnPtt.textContent = 'Press a key…'
  advise(ui.pttAdvice, 'ok',
    'Use a key you never type with: Caps Lock, Right Ctrl, Menu, or F13–F24 ' +
    'from a programmable keyboard. Esc to cancel.')
})

window.addEventListener('keydown', async (e) => {
  if (!capturing && !capturingPtt) return
  e.preventDefault()
  e.stopPropagation()

  if (e.code === 'Escape') {
    capturing = capturingPtt = false
    ui.btnCapture.classList.remove('is-listening')
    ui.btnPtt.classList.remove('is-listening')
    await refresh()
    advise(ui.hotkeyAdvice, null, null)
    advise(ui.pttAdvice, null, null)
    return
  }

  if (capturing) {
    const accel = acceleratorFrom(e)
    if (!accel) {
      advise(ui.hotkeyAdvice, 'warn', 'Needs a modifier plus a letter, digit or F-key.')
      return
    }
    capturing = false
    ui.btnCapture.classList.remove('is-listening')
    await applyAccelerator(accel)
    return
  }

  if (capturingPtt) {
    // Deliberately not bindable. On a Belgian/French layout Right Alt is
    // AltGr: Windows reports it as Ctrl+Alt, and suppressing it silently
    // removes @ # € [ ] from the keyboard for as long as it is bound.
    if (e.code === 'AltRight') {
      advise(ui.pttAdvice, 'error',
        'Right Alt is AltGr on this keyboard. Binding it would stop you ' +
        'typing @ # € [ and ]. Use Caps Lock, Menu, or F13–F24.')
      return
    }
    const mapped = PTT_KEYS[e.code]
    if (!mapped) {
      advise(ui.pttAdvice, 'warn',
        `"${e.code}" is a typing key. Sotto swallows the key it listens on, ` +
        'so binding it would stop you typing that character.')
      return
    }
    capturingPtt = false
    ui.btnPtt.classList.remove('is-listening')
    const [vk, label] = mapped
    await api.setConfig({ hotkey_vk: vk })
    ui.btnPtt.textContent = label
    advise(ui.pttAdvice, 'ok', `Push-to-talk is now ${label}.`)
  }
}, true)

// ---- config --------------------------------------------------------------
let saveTimer = null
function queueSave (patch) {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(async () => {
    const cfg = await api.setConfig(patch)
    if (cfg) status('Saved')
    else advise(ui.saveAdvice, 'error', 'Engine is not running — nothing was saved.')
  }, 200)
}

ui.selStt.addEventListener('change', () => queueSave({ stt_model: ui.selStt.value }))
ui.selLang.addEventListener('change', () =>
  queueSave({ language: ui.selLang.value || null }))
ui.selPolish.addEventListener('change', () => {
  ui.inPolishModel.disabled = ui.selPolish.value !== 'ollama'
  queueSave({ polish_backend: ui.selPolish.value })
})
ui.inPolishModel.addEventListener('change', () =>
  queueSave({ polish_model: ui.inPolishModel.value.trim() }))
ui.selDevice.addEventListener('change', () =>
  queueSave({ input_device: ui.selDevice.value || null }))

ui.btnClose.addEventListener('click', () => api.closeSettings())

// ---- application ---------------------------------------------------------
const btnStartup = $('btnStartup')
const btnIndicator = $('btnIndicator')
const engineMode = $('engineMode')

function paintToggle (btn, on) {
  btn.textContent = on ? 'On' : 'Off'
  btn.classList.toggle('is-down', on)
}

btnStartup.addEventListener('click', async () => {
  paintToggle(btnStartup, await api.setStartup(btnStartup.textContent !== 'On'))
})

btnIndicator.addEventListener('click', async () => {
  paintToggle(btnIndicator, await api.setIndicator(btnIndicator.textContent !== 'On'))
})

api.onSupervisor((s) => {
  engineMode.textContent = s.error ? 'Not running' : (s.message || 'Running')
})

async function refresh () {
  paintToggle(btnStartup, await api.getStartup())
  paintToggle(btnIndicator, await api.getIndicator())
  const sup = await api.supervisor()
  engineMode.textContent = sup && sup.error
    ? 'Not running' : ((sup && sup.message) || 'Running')

  const hk = await api.getHotkey()
  if (hk) {
    ui.btnCapture.textContent = hk.accelerator
    if (!hk.registered) advise(ui.hotkeyAdvice, 'error', hk.reason || 'Not registered.')
  }

  const cfg = await api.getConfig()
  if (!cfg) {
    advise(ui.saveAdvice, 'error',
      'The engine is not running, so settings cannot be read or changed. ' +
      'Start it and reopen this window.')
    for (const n of [ui.selStt, ui.selLang, ui.selPolish, ui.inPolishModel,
                     ui.selDevice, ui.btnPtt]) {
      n.disabled = true
    }
    return
  }

  ui.btnPtt.textContent = VK_NAMES[cfg.hotkey_vk] ||
    ('VK 0x' + Number(cfg.hotkey_vk).toString(16).toUpperCase())
  ui.selStt.value = cfg.stt_model
  ui.selLang.value = cfg.language || ''
  ui.selPolish.value = cfg.polish_backend
  ui.inPolishModel.value = cfg.polish_model
  ui.inPolishModel.disabled = cfg.polish_backend !== 'ollama'

  // The engine already returns one row per physical input, labelled without
  // the host-API suffix. Loopbacks go last: they are system audio, not a
  // microphone, and picking one is the classic "it cannot hear me" mistake.
  const devices = await api.listDevices()
  const mics = devices.filter(d => !d.loopback)
  const loopbacks = devices.filter(d => d.loopback)

  const options = [new Option('System default', '')]
  for (const d of mics) options.push(new Option(d.label || d.name, d.label || d.name))
  for (const d of loopbacks) {
    options.push(new Option((d.label || d.name) + '  — system audio, not a mic',
                            d.label || d.name))
  }

  ui.selDevice.replaceChildren(...options)
  ui.selDevice.value = cfg.input_device || ''

  // A device saved by an older build may not match any label. Show it
  // rather than silently displaying whatever happens to be first.
  if (cfg.input_device && ui.selDevice.value !== cfg.input_device) {
    const stray = new Option(cfg.input_device + '  — saved earlier',
                             cfg.input_device)
    ui.selDevice.insertBefore(stray, ui.selDevice.options[1] || null)
    ui.selDevice.value = cfg.input_device
    advise(ui.saveAdvice, 'warn',
      'The saved microphone is not in the current list. Pick one from the ' +
      'list to be sure Sotto is using a working input.')
  }
}

api.onHotkey((s) => {
  ui.btnCapture.textContent = s.accelerator
  if (!s.registered) advise(ui.hotkeyAdvice, 'error', s.reason || 'Not registered.')
})

refresh()
