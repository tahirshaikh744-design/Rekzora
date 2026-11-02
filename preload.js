'use strict';
/* Rekzora preload: a small, typed, security-reviewed bridge. */

const { contextBridge, ipcRenderer } = require('electron');

const SENDED_EVENTS = new Set([
  'rec:state', 'float:action', 'region:done', 'region:cancel',
  'app:window', 'app:log', 'app:open-external', 'app:drag-start', 'app:quit'
]);

const LISTEN_EVENTS = new Set([
  'recorder:action', 'float:state', 'region:result', 'recordings:changed'
]);

function send(channel, ...args) {
  if (SENDED_EVENTS.has(channel)) ipcRenderer.send(channel, ...args);
}
function on(channel, cb) {
  if (!LISTEN_EVENTS.has(channel) || typeof cb !== 'function') return () => {};
  const wrapped = (_e, ...args) => cb(...args);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}
const invoke = (channel, ...args) => {
  const allowed = new Set([
    'settings:get', 'settings:set', 'sources:get', 'capture:select-source', 'screen:primary-fast',
    'rec:begin', 'rec:chunk', 'rec:finish', 'rec:discard',
    'recordings:list', 'recording:delete', 'recording:rename', 'recording:open',
    'recordings:folder-pick', 'recordings:folder-open',
    'region:begin', 'region:get-bounds',
    'float:show', 'float:hide', 'app:version',
    'app:clipboard-write', 'share:apps', 'share:launch', 'share:openwith'
  ]);
  return allowed.has(channel) ? ipcRenderer.invoke(channel, ...args) : Promise.reject(new Error('channel not allowed'));
};

contextBridge.exposeInMainWorld('rekzora', {
  settings: {
    get: () => invoke('settings:get'),
    set: (patch) => invoke('settings:set', patch)
  },
  sources: {
    list: () => invoke('sources:get')
  },
  capture: {
    selectSource: (id) => invoke('capture:select-source', id),
    primaryScreen: () => invoke('screen:primary-fast')
  },
  rec: {
    begin: () => invoke('rec:begin'),
    chunk: (tempPath, u8) => invoke('rec:chunk', tempPath, u8),
    finish: (payload) => invoke('rec:finish', payload),
    discard: (tempPath) => invoke('rec:discard', tempPath),
    state: (s) => send('rec:state', s)
  },
  recordings: {
    list: () => invoke('recordings:list'),
    remove: (p) => invoke('recording:delete', p),
    rename: (path, newName) => invoke('recording:rename', { path, newName }),
    reveal: (p) => invoke('recording:open', p),
    pickFolder: () => invoke('recordings:folder-pick'),
    openFolder: () => invoke('recordings:folder-open'),
    onChanged: (cb) => on('recordings:changed', cb)
  },
  region: {
    begin: (payload) => invoke('region:begin', payload),
    getBounds: () => invoke('region:get-bounds'),
    onResult: (cb) => on('region:result', cb),
    sendDone: (rect) => send('region:done', rect),
    sendCancel: () => send('region:cancel')
  },
  float: {
    show: (bounds) => invoke('float:show', bounds),
    hide: () => invoke('float:hide'),
    action: (action) => send('float:action', action),
    onState: (cb) => on('float:state', cb)
  },
  actions: {
    on: (cb) => on('recorder:action', cb)
  },
  win: {
    minimize: () => send('app:window', 'minimize'),
    toggleMaximize: () => send('app:window', 'maximize'),
    close: () => send('app:window', 'close'),
    quit: () => send('app:quit')
  },
  meta: {
    version: () => invoke('app:version')
  },
  clipboard: {
    write: (t) => invoke('app:clipboard-write', t)
  },
  drag: {
    start: (p) => send('app:drag-start', p)
  },
  share: {
    apps: (payload) => invoke('share:apps', payload),
    launch: (payload) => invoke('share:launch', payload),
    openWith: (p) => invoke('share:openwith', p)
  },
  log: (...a) => send('app:log', a.map(String)),
  openExternal: (url) => send('app:open-external', url)
});
