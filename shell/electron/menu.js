'use strict'

const { Menu, shell, app, dialog } = require('electron')

/**
 * The application menu. A real one — this is a desktop app, not a tray
 * utility, so the standard verbs live where Windows users expect them.
 */
function buildMenu (ctx) {
  const template = [
    {
      label: '&File',
      submenu: [
        {
          label: 'Settings',
          accelerator: 'CmdOrCtrl+,',
          click: () => ctx.openSettings(),
        },
        { type: 'separator' },
        {
          label: 'Open Dictionary File',
          click: () => shell.openPath(ctx.dictionary.path),
        },
        {
          label: 'Show Dictionary in Explorer',
          click: () => shell.showItemInFolder(ctx.dictionary.path),
        },
        { type: 'separator' },
        { role: 'quit', label: 'Exit', accelerator: 'CmdOrCtrl+Q' },
      ],
    },
    {
      label: '&Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: '&Record',
      submenu: [
        {
          label: 'Start Dictation',
          accelerator: 'CmdOrCtrl+R',
          click: () => ctx.core.send({ cmd: 'start' }),
        },
        {
          label: 'Stop Dictation',
          accelerator: 'CmdOrCtrl+.',
          click: () => ctx.core.send({ cmd: 'stop' }),
        },
      ],
    },
    {
      label: '&View',
      submenu: [
        {
          label: 'Transcriptions',
          accelerator: 'CmdOrCtrl+1',
          click: () => ctx.showView('transcriptions'),
        },
        {
          label: 'Dictionary',
          accelerator: 'CmdOrCtrl+2',
          click: () => ctx.showView('dictionary'),
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: '&Help',
      submenu: [
        {
          label: 'Open Logs Folder',
          click: () => shell.openPath(ctx.logPath),
        },
        {
          label: 'Engine Status',
          click: () => {
            dialog.showMessageBox({
              type: 'info',
              title: 'Engine status',
              message: ctx.core.connected ? 'Engine connected' : 'Engine not running',
              detail: ctx.core.connected
                ? `Listening on ${ctx.core.host}:${ctx.core.port}.`
                : 'Sotto could not reach the transcription engine. Start it, ' +
                  'and this window will reconnect on its own.',
            })
          },
        },
        { type: 'separator' },
        {
          label: `About ${app.getName()}`,
          click: () => {
            dialog.showMessageBox({
              type: 'info',
              title: 'About Sotto',
              message: `Sotto ${app.getVersion()}`,
              detail: 'Local push-to-talk dictation.\n' +
                      'Speech and cleanup run on this machine.',
            })
          },
        },
      ],
    },
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

module.exports = { buildMenu }
