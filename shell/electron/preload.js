'use strict'

// The only bridge between the renderer and the main process.
// contextIsolation is on and nodeIntegration is off, so this file defines
// the complete surface the UI is allowed to touch. No fs, no net, no
// dictionary internals — just named calls.

const { contextBridge, ipcRenderer } = require('electron')

const on = (channel) => (handler) => {
  const wrapped = (_event, payload) => handler(payload)
  ipcRenderer.on(channel, wrapped)
  return () => ipcRenderer.removeListener(channel, wrapped)
}

contextBridge.exposeInMainWorld('sotto', {
  // --- engine state (push) ---------------------------------------------
  onState: on('engine:state'),
  onLevel: on('engine:level'),
  onResult: on('engine:result'),
  onEmpty: on('engine:empty'),
  onError: on('engine:error'),
  onWarning: on('engine:warning'),
  onConnection: on('engine:connection'),
  onHotkey: on('app:hotkey'),
  onView: on('app:view'),

  // --- transport --------------------------------------------------------
  start: () => ipcRenderer.invoke('engine:start'),
  stop: () => ipcRenderer.invoke('engine:stop'),
  status: () => ipcRenderer.invoke('engine:status'),

  // --- config -----------------------------------------------------------
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (patch) => ipcRenderer.invoke('config:set', patch),
  listDevices: () => ipcRenderer.invoke('config:devices'),

  // --- hotkey -----------------------------------------------------------
  getHotkey: () => ipcRenderer.invoke('hotkey:get'),
  setHotkey: (accelerator) => ipcRenderer.invoke('hotkey:set', accelerator),

  // --- history ----------------------------------------------------------
  history: {
    list: (query) => ipcRenderer.invoke('history:list', query),
    remove: (id) => ipcRenderer.invoke('history:remove', id),
    clear: () => ipcRenderer.invoke('history:clear'),
    onChanged: on('history:changed'),
  },

  // --- dictionary -------------------------------------------------------
  dictionary: {
    list: (query) => ipcRenderer.invoke('dict:list', query),
    add: (entry) => ipcRenderer.invoke('dict:add', entry),
    update: (id, patch) => ipcRenderer.invoke('dict:update', { id, patch }),
    remove: (id) => ipcRenderer.invoke('dict:remove', id),
    assess: (from) => ipcRenderer.invoke('dict:assess', from),
    preview: (from, sample) => ipcRenderer.invoke('dict:preview', { from, sample }),
    openFile: () => ipcRenderer.invoke('dict:open-file'),
    revealFile: () => ipcRenderer.invoke('dict:reveal-file'),
    filePath: () => ipcRenderer.invoke('dict:path'),
    onChanged: on('dict:changed'),
  },

  // --- engine supervision -----------------------------------------------
  onSupervisor: on('engine:supervisor'),
  supervisor: () => ipcRenderer.invoke('engine:supervisor'),
  getStartup: () => ipcRenderer.invoke('app:get-startup'),
  setStartup: (enabled) => ipcRenderer.invoke('app:set-startup', enabled),
  sizeIndicator: (size) => ipcRenderer.send('indicator:size', size),
  getIndicator: () => ipcRenderer.invoke('app:get-indicator'),
  setIndicator: (enabled) => ipcRenderer.invoke('app:set-indicator', enabled),

  // --- shell ------------------------------------------------------------
  copy: (text) => ipcRenderer.invoke('app:copy', text),
  openSettings: () => ipcRenderer.invoke('app:settings'),
  closeSettings: () => ipcRenderer.invoke('app:close-settings'),
})
