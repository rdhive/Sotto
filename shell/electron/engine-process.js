'use strict'

// Starts and supervises the Python engine so the user never runs a command.
//
// Two modes, decided at startup:
//   adopt  an engine is already listening (started by hand, or left running
//          by a previous session). Connect to it and leave it alone — it is
//          not ours to kill.
//   own    nothing is listening. Spawn one, watch it, restart it if it dies,
//          and shut it down when the app quits.
//
// The child is spawned with no console window. Its own logging goes to
// %APPDATA%\Sotto\logs; what we capture here is only for surfacing a fatal
// startup failure in the UI.

const { execFile, spawn } = require('child_process')
const { EventEmitter } = require('events')
const fs = require('fs')
const net = require('net')
const path = require('path')

const RESTART_BACKOFF_MS = [1000, 2000, 5000, 10000]
const CRASH_WINDOW_MS = 60000

function portInUse (host, port, timeout = 600) {
  return new Promise((resolve) => {
    const sock = new net.Socket()
    const done = (result) => {
      sock.destroy()
      resolve(result)
    }
    sock.setTimeout(timeout)
    sock.once('connect', () => done(true))
    sock.once('timeout', () => done(false))
    sock.once('error', () => done(false))
    sock.connect(port, host)
  })
}

class EngineProcess extends EventEmitter {
  constructor ({ host, port, appRoot, isPackaged, resourcesPath }) {
    super()
    this.host = host
    this.port = port
    this.appRoot = appRoot
    this.isPackaged = isPackaged
    this.resourcesPath = resourcesPath
    this.child = null
    this.mode = null            // 'adopt' | 'own'
    this.stopping = false
    this.crashes = []
    this.lastError = null
  }

  /**
   * Where the engine lives.
   *
   * Packaged: a frozen executable shipped beside the app, so there is no
   * Python installation to depend on.
   * Development: the project venv, run with pythonw so no console appears.
   */
  resolveCommand () {
    const frozen = path.join(this.resourcesPath || '', 'engine', 'sotto-engine.exe')
    if (fs.existsSync(frozen)) {
      return { command: frozen, args: [], cwd: path.dirname(frozen), kind: 'frozen' }
    }

    const repo = path.resolve(this.appRoot, '..')
    const pyw = path.join(repo, '.venv', 'Scripts', 'pythonw.exe')
    const core = path.join(repo, 'core')
    if (fs.existsSync(pyw) && fs.existsSync(core)) {
      return { command: pyw, args: ['-m', 'sotto'], cwd: core, kind: 'venv' }
    }
    return null
  }

  async start () {
    if (await portInUse(this.host, this.port)) {
      this.mode = 'adopt'
      this.emit('status', { mode: 'adopt', message: 'Using the engine already running.' })
      return
    }

    const target = this.resolveCommand()
    if (!target) {
      this.lastError =
        'The speech engine is missing. Reinstall Sotto, or start it manually ' +
        'from the project if you are running from source.'
      this.emit('status', { mode: 'missing', error: this.lastError })
      return
    }

    this.mode = 'own'
    this._spawn(target)
  }

  _spawn (target) {
    this.emit('status', { mode: 'own', message: 'Starting the speech engine…', kind: target.kind })

    const child = spawn(target.command, target.args, {
      cwd: target.cwd,
      windowsHide: true,          // no flash of a console window
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
    })
    this.child = child

    let tail = ''
    const capture = (buf) => {
      tail = (tail + buf.toString('utf8')).slice(-4000)
    }
    child.stdout.on('data', capture)
    child.stderr.on('data', capture)

    child.on('error', (err) => {
      this.lastError = `Could not start the speech engine: ${err.message}`
      this.emit('status', { mode: 'own', error: this.lastError })
    })

    child.on('exit', (code, signal) => {
      this.child = null
      if (this.stopping) return

      // Exit code 1 with the port already bound means a second engine was
      // started behind our back. Adopt it rather than fighting over it.
      if (/already in use/i.test(tail)) {
        this.mode = 'adopt'
        this.emit('status', { mode: 'adopt', message: 'Using the engine already running.' })
        return
      }

      const now = Date.now()
      this.crashes = this.crashes.filter(t => now - t < CRASH_WINDOW_MS)
      this.crashes.push(now)

      if (this.crashes.length > RESTART_BACKOFF_MS.length) {
        this.lastError =
          'The speech engine keeps stopping. Check the log from Help → Open ' +
          'Logs Folder.\n\n' + tail.split('\n').slice(-6).join('\n').trim()
        this.emit('status', { mode: 'own', error: this.lastError, fatal: true })
        return
      }

      const wait = RESTART_BACKOFF_MS[this.crashes.length - 1]
      this.emit('status', {
        mode: 'own',
        message: `Engine stopped (${signal || 'code ' + code}). Restarting…`,
      })
      setTimeout(() => {
        if (!this.stopping) this._spawn(target)
      }, wait)
    })
  }

  async stop () {
    this.stopping = true
    const child = this.child
    if (!child || this.mode !== 'own') return

    // Kill the whole tree, not just our direct child. The venv's
    // pythonw.exe is a launcher shim that runs the real interpreter as a
    // child of itself — killing only the shim leaves the engine running,
    // holding the port and the keyboard hook.
    const exited = new Promise((resolve) => {
      const timer = setTimeout(resolve, 4000)
      child.once('exit', () => { clearTimeout(timer); resolve() })
    })

    await new Promise((resolve) => {
      execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'],
        { windowsHide: true }, () => resolve())
    })
    await exited
    this.child = null
  }
}

module.exports = { EngineProcess, portInUse }
