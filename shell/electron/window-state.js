'use strict'

// Remembers window geometry between launches, and refuses to restore a
// window onto a monitor that is no longer attached — otherwise unplugging a
// second display leaves the app opening off-screen with no way back.

const fs = require('fs')
const path = require('path')
const { screen } = require('electron')

class WindowState {
  constructor (userDataPath, name, defaults) {
    this.file = path.join(userDataPath, `window-${name}.json`)
    this.defaults = defaults
    this.state = this._read()
    this._saveTimer = null
  }

  _read () {
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      if (this._visibleOnSomeDisplay(saved)) return saved
    } catch (err) {
      // No state yet, or it is unreadable. Defaults are fine.
    }
    return { ...this.defaults }
  }

  _visibleOnSomeDisplay (s) {
    if (!s || !Number.isFinite(s.x) || !Number.isFinite(s.y)) return false
    // Require a decent overlap, not a single pixel, so a window cannot come
    // back with only its corner reachable.
    return screen.getAllDisplays().some(({ workArea: a }) => {
      const overlapX = Math.min(s.x + s.width, a.x + a.width) - Math.max(s.x, a.x)
      const overlapY = Math.min(s.y + s.height, a.y + a.height) - Math.max(s.y, a.y)
      return overlapX > 120 && overlapY > 80
    })
  }

  get bounds () {
    const { x, y, width, height } = this.state
    const b = { width, height }
    if (Number.isFinite(x) && Number.isFinite(y)) { b.x = x; b.y = y }
    return b
  }

  get maximized () {
    return !!this.state.maximized
  }

  /** Track a window. Saves are debounced — resize fires continuously. */
  manage (win) {
    const capture = () => {
      if (win.isDestroyed()) return
      // Only record normal bounds; restoring a maximized window uses the
      // flag, and saving maximized bounds would leave it un-restorable.
      if (!win.isMaximized() && !win.isMinimized() && !win.isFullScreen()) {
        Object.assign(this.state, win.getNormalBounds())
      }
      this.state.maximized = win.isMaximized()
      this._queueSave()
    }

    for (const evt of ['resize', 'move', 'maximize', 'unmaximize']) {
      win.on(evt, capture)
    }
    win.on('close', () => { capture(); this._flush() })

    if (this.maximized) win.maximize()
  }

  _queueSave () {
    clearTimeout(this._saveTimer)
    this._saveTimer = setTimeout(() => this._flush(), 400)
  }

  _flush () {
    clearTimeout(this._saveTimer)
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2), 'utf8')
    } catch (err) {
      // Losing geometry is not worth failing a close over.
    }
  }
}

module.exports = { WindowState }
