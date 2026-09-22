'use strict'

// Sotto — desktop application.
//
// The window is the app, but closing it hides to the tray rather than
// quitting — dictation is a background service and the global shortcut has
// to keep working with no window on screen. Quitting is explicit: the tray
// menu, File > Exit, or Ctrl+Q.
//
// Everything with access to disk or the network lives here. The renderer
// runs with contextIsolation on and nodeIntegration off, and reaches this
// process only through the named calls in preload.js.

const {
  app, BrowserWindow, Menu, Tray, ipcMain, shell, clipboard,
  globalShortcut, nativeImage, dialog, screen, nativeTheme,
} = require('electron')
const fs = require('fs')
const path = require('path')

const { CoreClient } = require('./core-client')
const { Dictionary, assessRisk } = require('./dictionary')
const { History } = require('./history')
const { WindowState } = require('./window-state')
const { EngineProcess } = require('./engine-process')
const { buildMenu } = require('./menu')

const CORE_HOST = '127.0.0.1'
const CORE_PORT = 8765
const DEFAULT_ACCELERATOR = 'CommandOrControl+Shift+D'

// Window canvas colours from tokens.css (--c-bg / --c-text). The native
// title bar buttons are drawn by Windows, so they have to be told the colour
// explicitly, and told again when the Windows light/dark setting changes.
const CHROME = {
  light: { bg: '#f5f5f7', fg: '#1d1d1f' },
  dark: { bg: '#161618', fg: '#f5f5f7' },
}
const chrome = () => CHROME[nativeTheme.shouldUseDarkColors ? 'dark' : 'light']
const titleBarOverlay = () => ({ color: chrome().bg, symbolColor: chrome().fg, height: 38 })

nativeTheme.on('updated', () => {
  for (const win of [mainWindow, settingsWindow]) {
    if (!win || win.isDestroyed()) continue
    win.setBackgroundColor(chrome().bg)
    try { win.setTitleBarOverlay(titleBarOverlay()) } catch (err) { /* not fatal */ }
  }
})

// Windows uses this to group taskbar buttons and to bind pinned shortcuts
// to the running app. Without it a pinned icon spawns a second entry.
app.setAppUserModelId('be.rdhive.sotto')

let mainWindow = null
let settingsWindow = null
let tray = null
let core = null
let dictionary = null
let history = null
let mainState = null
let prefs = null
let hotkeyStatus = { accelerator: DEFAULT_ACCELERATOR, registered: false, reason: null }
let pendingCorrections = new Map()
let engineProc = null
let supervisor = { message: null, error: null }
let quitting = false
// Distinguishes "user closed the window" (hide) from "user asked to quit"
// (really exit). Without it there is no way to ever close the app.
let allowClose = false
let indicatorWindow = null
let indicatorHideTimer = null

// Starting size only. The renderer measures itself once fonts are loaded
// and reports back, because a hard-coded width clips as soon as a label or
// the font metrics change.
let indicatorSize = { width: 320, height: 62 }

// --- small prefs store ----------------------------------------------------
function loadPrefs () {
  const file = path.join(app.getPath('userData'), 'app-settings.json')
  let data = {}
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    // First run.
  }
  return {
    file,
    get accelerator () { return data.accelerator || DEFAULT_ACCELERATOR },
    set accelerator (v) { data.accelerator = v; this.save() },
    get lastView () { return data.lastView || 'transcriptions' },
    set lastView (v) { data.lastView = v; this.save() },
    get showIndicator () { return data.showIndicator !== false },
    set showIndicator (v) { data.showIndicator = !!v; this.save() },
    get toldAboutTray () { return !!data.toldAboutTray },
    set toldAboutTray (v) { data.toldAboutTray = !!v; this.save() },
    save () {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8')
      } catch (err) { /* not fatal */ }
    },
  }
}

// --- windows --------------------------------------------------------------
function createMainWindow () {
  mainState = new WindowState(app.getPath('userData'), 'main', {
    width: 1080, height: 720,
  })

  mainWindow = new BrowserWindow({
    ...mainState.bounds,
    minWidth: 720,
    minHeight: 480,
    show: false,                    // shown on ready-to-show, not kept hidden
    backgroundColor: chrome().bg,
    // Frameless for the custom title bar, but with the real overlay so Snap
    // Layouts still appear on hover over maximize. A hand-drawn title bar
    // would break window snapping, which is not a trade worth making.
    frame: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: titleBarOverlay(),
    icon: path.join(__dirname, '..', 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  mainState.manage(mainWindow)
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'))

  const reveal = () => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isVisible()) return
    mainWindow.show()
    send('app:view', { view: prefs.lastView })
    send('app:hotkey', hotkeyStatus)
    send('engine:supervisor', supervisor)
  }

  mainWindow.once('ready-to-show', reveal)
  // Safety net: if the renderer fails before its first paint, ready-to-show
  // never fires and the app sits invisible with no way to reach it. Showing
  // a broken window beats showing nothing.
  setTimeout(reveal, 4000)

  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error('[sotto] renderer failed to load:', code, desc, url)
    reveal()
  })
  mainWindow.webContents.on('preload-error', (_e, file, err) => {
    console.error('[sotto] preload error in', file, err)
  })
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('[sotto] renderer gone:', details.reason)
  })
  mainWindow.webContents.on('console-message', (_e, level, message, line, src) => {
    if (level >= 2) console.error('[renderer]', message, `(${src}:${line})`)
  })

  mainWindow.on('close', (event) => {
    if (allowClose) return          // a real quit: let it through
    event.preventDefault()
    mainWindow.hide()               // hiding drops the taskbar button too
    announceTray()
  })

  mainWindow.on('closed', () => { mainWindow = null })

  // External links open in the real browser, never inside the app frame.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
}

function openSettings () {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus()
    return
  }
  settingsWindow = new BrowserWindow({
    width: 560,
    height: 720,
    parent: mainWindow || undefined,
    modal: false,
    resizable: true,
    minimizable: false,
    maximizable: false,
    show: false,
    backgroundColor: chrome().bg,
    frame: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: titleBarOverlay(),
    icon: path.join(__dirname, '..', 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  settingsWindow.loadFile(path.join(__dirname, '..', 'renderer', 'settings.html'))
  settingsWindow.once('ready-to-show', () => settingsWindow.show())
  settingsWindow.on('closed', () => { settingsWindow = null })
}

function send (channel, payload) {
  for (const win of [mainWindow, settingsWindow, indicatorWindow]) {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

// --- recording indicator --------------------------------------------------
// In toggle mode you are dictating into another application, so the meters
// in the main window are behind whatever you are typing into. This floats a
// small piece of the front panel on top: lamp, level, elapsed time.
//
// It is a readout, not a window — click-through, never focused, no taskbar
// entry. Clicking it must not interrupt what you are doing.
function createIndicator () {
  if (indicatorWindow && !indicatorWindow.isDestroyed()) return indicatorWindow

  indicatorWindow = new BrowserWindow({
    width: indicatorSize.width,
    height: indicatorSize.height,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    focusable: false,          // must never steal focus from the target app
    hasShadow: false,
    show: false,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  // Above fullscreen apps and the taskbar.
  indicatorWindow.setAlwaysOnTop(true, 'screen-saver')
  indicatorWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  indicatorWindow.setIgnoreMouseEvents(true, { forward: true })
  indicatorWindow.loadFile(path.join(__dirname, '..', 'renderer', 'indicator.html'))
  indicatorWindow.on('closed', () => { indicatorWindow = null })
  return indicatorWindow
}

function positionIndicator (win) {
  // Follow the display the pointer is on, so it appears on the screen the
  // user is actually working on in a multi-monitor setup.
  const point = screen.getCursorScreenPoint()
  const { workArea } = screen.getDisplayNearestPoint(point)
  const { width, height } = indicatorSize
  win.setBounds({
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + workArea.height - height - 56),
    width,
    height,
  })
}

const INDICATOR_STATES = new Set([
  'recording', 'transcribing', 'polishing', 'injecting',
])

function updateIndicator (state) {
  if (!prefs.showIndicator) {
    if (indicatorWindow && !indicatorWindow.isDestroyed()) indicatorWindow.hide()
    return
  }

  clearTimeout(indicatorHideTimer)

  if (INDICATOR_STATES.has(state)) {
    const win = createIndicator()
    if (!win.isVisible()) {
      positionIndicator(win)
      win.showInactive()      // showInactive: never take focus
    }
    win.webContents.send('engine:state', { state })
    return
  }

  // Linger briefly so the final "Inserting" is readable rather than a flash.
  indicatorHideTimer = setTimeout(() => {
    if (indicatorWindow && !indicatorWindow.isDestroyed()) indicatorWindow.hide()
  }, 700)
}

function showView (view) {
  prefs.lastView = view
  focusMain()
  send('app:view', { view })
}

function quitApp () {
  allowClose = true
  app.quit()
}

// Say where the window went, once. Vanishing into the tray with no
// explanation is how apps get force-quit by people who think they hung.
function announceTray () {
  if (!tray || prefs.toldAboutTray) return
  prefs.toldAboutTray = true
  try {
    tray.displayBalloon({
      title: 'Sotto is still running',
      content: 'Dictation keeps working. Click the tray icon to reopen, or ' +
               'right-click it to quit.',
    })
  } catch (err) {
    // Balloons are Windows-only and can be suppressed by policy.
  }
}

function focusMain () {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  if (!mainWindow.isVisible()) mainWindow.show()
  mainWindow.focus()
}

// --- global hotkey --------------------------------------------------------
// The engine owns push-to-talk through its own low-level keyboard hook.
// This is the separate toggle: one press starts, the next stops, and it
// works from any application because it is registered with the OS.
function registerHotkey (accelerator) {
  globalShortcut.unregisterAll()
  hotkeyStatus = { accelerator, registered: false, reason: null }

  if (!accelerator) {
    hotkeyStatus.reason = 'No shortcut set.'
    send('app:hotkey', hotkeyStatus)
    return hotkeyStatus
  }

  let ok = false
  try {
    ok = globalShortcut.register(accelerator, () => {
      if (!core.connected) {
        focusMain()
        return
      }
      core.send({ cmd: core.lastState === 'recording' ? 'stop' : 'start' })
    })
  } catch (err) {
    hotkeyStatus.reason = err.message
  }

  hotkeyStatus.registered = ok && globalShortcut.isRegistered(accelerator)
  if (!hotkeyStatus.registered && !hotkeyStatus.reason) {
    // register() returning false on Windows means the combination is already
    // claimed by another process. There is no API to ask which one.
    hotkeyStatus.reason =
      `Windows refused ${accelerator} — another running application already ` +
      'owns this combination. Pick a different one in Settings.'
  }
  send('app:hotkey', hotkeyStatus)
  return hotkeyStatus
}

// --- tray -----------------------------------------------------------------
function trayIcon (recording) {
  // Real bitmaps, not SVG: nativeImage cannot decode SVG, and a Tray built
  // from an empty image is created without error and simply never appears.
  const file = recording ? 'tray-rec.ico' : 'tray-idle.ico'
  const img = nativeImage.createFromPath(
    path.join(__dirname, '..', 'assets', file))
  if (img.isEmpty()) {
    // Fall back to the app icon rather than an invisible tray entry.
    return nativeImage.createFromPath(
      path.join(__dirname, '..', 'assets', 'icon.ico'))
  }
  return img
}

function updateTray () {
  if (!tray) return
  const recording = core.lastState === 'recording'
  tray.setImage(trayIcon(recording))
  tray.setToolTip(
    !core.connected ? 'Sotto — engine not running'
      : recording ? 'Sotto — recording' : 'Sotto — ready'
  )
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show Sotto', click: focusMain },
    { type: 'separator' },
    {
      label: recording ? 'Stop dictation' : 'Start dictation',
      enabled: core.connected,
      click: () => core.send({ cmd: recording ? 'stop' : 'start' }),
    },
    {
      label: hotkeyStatus.registered
        ? `Shortcut: ${hotkeyStatus.accelerator}`
        : 'Shortcut unavailable',
      enabled: false,
    },
    { type: 'separator' },
    { label: 'Settings…', click: openSettings },
    { label: 'Quit Sotto', click: quitApp },
  ]))
}

// --- engine wiring --------------------------------------------------------
function wireCore () {
  core = new CoreClient(CORE_HOST, CORE_PORT)
  core.lastState = 'offline'

  // The engine asks before it injects; corrections are applied here.
  core.onTransform = (text) => dictionary.apply(text)

  core.on('corrections', ({ applied }) => {
    // Stash until the matching result arrives, so history can show what
    // the dictionary changed.
    pendingCorrections.set('last', applied)
  })

  core.on('connected', () => {
    // The supervisor's last word was "starting…" — it has no way to know
    // the engine finished, because readiness is a socket connecting, not a
    // process event. Clear it here or the label reads "starting" forever.
    supervisor = { message: null, error: null }
    send('engine:supervisor', supervisor)
    send('engine:connection', { connected: true })
    updateTray()
    pushBiasTerms()
  })

  core.on('disconnected', () => {
    core.lastState = 'offline'
    updateIndicator('offline')
    if (!supervisor.error) {
      supervisor = { message: 'Reconnecting…', error: null }
      send('engine:supervisor', supervisor)
    }
    send('engine:connection', { connected: false })
    send('engine:state', { state: 'offline' })
    updateTray()
  })

  core.on('state', (msg) => {
    core.lastState = msg.state
    send('engine:state', msg)
    updateTray()
    updateIndicator(msg.state)
  })

  core.on('level', (msg) => send('engine:level', msg))
  core.on('empty', (msg) => send('engine:empty', msg))
  core.on('error', (msg) => send('engine:error', msg))
  core.on('warning', (msg) => send('engine:warning', msg))

  core.on('result', (msg) => {
    const corrections = pendingCorrections.get('last') || []
    pendingCorrections.delete('last')
    const row = history.add({
      text: msg.text,
      raw: msg.raw,
      language: msg.language,
      latencyMs: msg.latency_ms,
      durationMs: msg.held_ms,
      corrections,
    })
    send('engine:result', row)
    send('history:changed', { entry: row })
  })

  core.start()
}

/**
 * Hand the dictionary to the speech engine as context so it leans toward
 * producing these words. Deliberately short — a long prompt makes Whisper
 * drift and invent text on quiet audio.
 */
function pushBiasTerms () {
  if (!core.connected) return
  core.send({ cmd: 'set_config', config: { dictionary: dictionary.biasTerms() } })
}

// --- ipc ------------------------------------------------------------------
function wireIpc () {
  ipcMain.handle('engine:start', () => core.send({ cmd: 'start' }))
  ipcMain.handle('engine:stop', () => core.send({ cmd: 'stop' }))
  ipcMain.handle('engine:status', () => ({
    connected: core.connected,
    state: core.lastState,
  }))

  ipcMain.handle('config:get', async () => {
    if (!core.connected) return null
    const reply = await core.request({ cmd: 'get_config' })
    return reply.config
  })
  ipcMain.handle('config:set', async (_e, patch) => {
    if (!core.connected) return null
    const reply = await core.request({ cmd: 'set_config', config: patch })
    return reply.config
  })
  ipcMain.handle('config:devices', async () => {
    if (!core.connected) return []
    const reply = await core.request({ cmd: 'list_devices' })
    return reply.devices || []
  })

  ipcMain.handle('engine:supervisor', () => supervisor)

  ipcMain.on('indicator:size', (_e, size) => {
    if (!size || !size.width || !size.height) return
    indicatorSize = {
      width: Math.min(900, Math.max(160, Math.round(size.width))),
      height: Math.min(200, Math.max(40, Math.round(size.height))),
    }
    if (indicatorWindow && !indicatorWindow.isDestroyed()) {
      positionIndicator(indicatorWindow)
    }
  })

  ipcMain.handle('app:get-indicator', () => prefs.showIndicator)
  ipcMain.handle('app:set-indicator', (_e, enabled) => {
    prefs.showIndicator = enabled
    updateIndicator(core.lastState)
    return prefs.showIndicator
  })

  ipcMain.handle('app:get-startup', () =>
    app.getLoginItemSettings({ args: ['--startup'] }).openAtLogin)
  ipcMain.handle('app:set-startup', (_e, enabled) => {
    // Launching at login starts the whole app; the engine comes up with it,
    // which is the point — dictation should be available without opening
    // anything.
    app.setLoginItemSettings({
      openAtLogin: !!enabled,
      path: process.execPath,
      args: ['--startup'],
    })
    return app.getLoginItemSettings({ args: ['--startup'] }).openAtLogin
  })

  ipcMain.handle('hotkey:get', () => hotkeyStatus)
  ipcMain.handle('hotkey:set', (_e, accelerator) => {
    prefs.accelerator = accelerator
    const status = registerHotkey(accelerator)
    updateTray()
    return status
  })

  ipcMain.handle('history:list', (_e, query) => history.search(query))
  ipcMain.handle('history:remove', (_e, id) => history.remove(id))
  ipcMain.handle('history:clear', () => { history.clear(); return true })

  ipcMain.handle('dict:list', (_e, query) => dictionary.search(query))
  ipcMain.handle('dict:add', (_e, entry) => {
    const row = dictionary.add(entry)
    pushBiasTerms()
    return row
  })
  ipcMain.handle('dict:update', (_e, { id, patch }) => {
    const row = dictionary.update(id, patch)
    pushBiasTerms()
    return row
  })
  ipcMain.handle('dict:remove', (_e, id) => {
    const ok = dictionary.remove(id)
    pushBiasTerms()
    return ok
  })
  ipcMain.handle('dict:assess', (_e, from) => assessRisk(from))
  ipcMain.handle('dict:preview', (_e, { from, sample }) => {
    // Show the user what an entry would do to a sentence before saving it.
    const probe = new Dictionary(app.getPath('userData'))
    probe.entries = [{ id: 'probe', type: 'correction', from, to: '█' }]
    probe._rules = null
    const out = probe.apply(sample || '')
    return { text: out.text, hits: out.applied.length }
  })
  ipcMain.handle('dict:open-file', () => shell.openPath(dictionary.path))
  ipcMain.handle('dict:reveal-file', () => shell.showItemInFolder(dictionary.path))
  ipcMain.handle('dict:path', () => dictionary.path)

  ipcMain.handle('app:copy', (_e, text) => { clipboard.writeText(String(text)); return true })
  ipcMain.handle('app:settings', () => openSettings())
  ipcMain.handle('app:close-settings', () => {
    if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.close()
  })
}

// --- lifecycle ------------------------------------------------------------
// Startup breadcrumbs. Electron's stdout is not reliably attached on
// Windows, so a startup failure otherwise looks like the app silently
// doing nothing — which is exactly what happened while building this.
const bootLog = (msg) => {
  try {
    fs.appendFileSync(
      path.join(app.getPath('appData'), 'Sotto', 'boot.log'),
      `${new Date().toISOString()}  ${msg}\n`
    )
  } catch (err) { /* never fail startup over logging */ }
}

if (!app.requestSingleInstanceLock()) {
  bootLog('exiting: another instance already holds the single-instance lock')
  app.quit()
} else {
  bootLog('got single-instance lock')
  // A second launch — including clicking the pinned taskbar icon — focuses
  // the window that already exists instead of starting another copy.
  app.on('second-instance', focusMain)

  app.whenReady().then(() => {
    bootLog('app ready')
    prefs = loadPrefs()

    dictionary = new Dictionary(app.getPath('userData'))
    dictionary.load()
    dictionary.watch()
    dictionary.on('changed', () => {
      send('dict:changed', dictionary.entries)
      pushBiasTerms()
    })
    dictionary.on('error', (err) => {
      dialog.showMessageBox({
        type: 'warning',
        title: 'Dictionary file',
        message: 'Could not read dictionary.json',
        detail: err.message,
      })
    })

    history = new History(app.getPath('userData'))

    engineProc = new EngineProcess({
      host: CORE_HOST,
      port: CORE_PORT,
      appRoot: app.getAppPath(),
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
    })
    engineProc.on('status', (status) => {
      supervisor = { message: status.message || null, error: status.error || null }
      send('engine:supervisor', supervisor)
    })

    wireCore()
    wireIpc()
    createMainWindow()

    // Not awaited: the window should paint immediately and show progress
    // rather than sit blank while a 1.6 GB model loads.
    engineProc.start()

    tray = new Tray(trayIcon(false))
    updateTray()
    tray.on('click', focusMain)
    tray.on('double-click', focusMain)

    buildMenu({
      openSettings,
      showView,
      dictionary,
      core,
      logPath: path.join(app.getPath('appData'), 'Sotto', 'logs'),
    })

    registerHotkey(prefs.accelerator)
    bootLog('startup complete')
  }).catch((err) => bootLog('startup FAILED: ' + (err && err.stack || err)))

  app.on('before-quit', async (event) => {
    allowClose = true            // let the window actually close now
    if (quitting) return
    event.preventDefault()
    quitting = true
    if (core) core.stop()
    if (engineProc) await engineProc.stop()
    app.quit()
  })

  app.on('will-quit', () => {
    clearTimeout(indicatorHideTimer)
    if (indicatorWindow && !indicatorWindow.isDestroyed()) indicatorWindow.destroy()
    globalShortcut.unregisterAll()
    if (dictionary) dictionary.unwatch()
    if (history) history.flush()
    if (core) core.stop()
  })

  // Deliberately empty: the app lives in the tray once the window is
  // hidden, and hiding does not fire this anyway.
  app.on('window-all-closed', () => {})
}
