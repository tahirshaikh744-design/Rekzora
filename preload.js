'use strict';
/* ============================================================
   Rekzora preload: a small, typed, security-reviewed bridge.

   v1.1 least-privilege model: the window's role travels via
   webPreferences.additionalArguments (--rekzora-role=MAIN|FLOATING|REGION)
   and only the API slice that role needs is ever exposed.

   MAIN     — full application surface (recording, library, share, settings)
   FLOATING — recording-toolbar actions + state updates + logging
   REGION   — region-picker results/cancel + logging
   (anything else → an empty bridge; fail closed)

   Keep the channel lists in sync with lib/ipc-guard.js ROLE_CHANNELS:
   tests/preload-role-parity.test.js verifies the two files agree.
   ============================================================ */

const { contextBridge, ipcRenderer } = require('electron');

function roleFromArgv() {
  const arg = (process.argv || []).find((a) => typeof a === 'string' && a.startsWith('--rekzora-role='));
  return arg ? arg.slice('--rekzora-role='.length) : 'MAIN';
}
const ROLE = roleFromArgv();

/* ---------- channel policy (mirrors ROLE_CHANNELS in lib/ipc-guard.js) ---------- */
const CHANNELS_MAIN = [
  'settings:get', 'settings:set', 'sources:get', 'capture:select-source', 'screen:primary-fast',
  'rec:begin', 'rec:chunk', 'rec:finish', 'rec:discard',
  'recordings:list', 'recording:delete', 'recording:rename', 'recording:open', 'recording:path',
  'recordings:folder-pick', 'recordings:folder-open',
  'region:begin', 'region:get-bounds',
  'float:show', 'float:hide',
  'app:version', 'app:clipboard-write',
  'share:apps', 'share:launch', 'share:openwith',
  'recovery:list', 'recovery:recover', 'recovery:delete', 'recovery:dismiss'
];
const CHANNELS_FLOATING = [];
const CHANNELS_REGION = [];

const SEND_CHANNELS = new Set([
  'rec:state', 'float:action', 'region:done', 'region:cancel',
  'app:window', 'app:log', 'app:open-external', 'app:drag-start', 'app:quit'
]);
const LISTEN_EVENTS = new Set([
  'recorder:action', 'float:state', 'region:result', 'recordings:changed'
]);

function send(channel, ...args) {
  if (SEND_CHANNELS.has(channel)) ipcRenderer.send(channel, ...args);
}
function on(channel, cb) {
  if (!LISTEN_EVENTS.has(channel) || typeof cb !== 'function') return () => {};
  const wrapped = (_e, ...args) => cb(...args);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}
const invoke = (channel, ...args) => {
  const pool = ROLE === 'MAIN' ? CHANNELS_MAIN : ROLE === 'FLOATING' ? CHANNELS_FLOATING : CHANNELS_REGION;
  return pool.includes(channel)
    ? ipcRenderer.invoke(channel, ...args)
    : Promise.reject(new Error(`channel not allowed for role ${ROLE}`));
};

/* ---------- bridges ---------- */

/* MAIN application surface.
   Recording sessions: the renderer only ever holds an opaque recordingId —
   no temp path is exposed to renderer JavaScript in v1.1 (P0 fix).
   Library: opaque record ids in and out; no filesystem paths cross IPC. */
const bridgeFull = {
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
    chunk: (recordingId, u8) => invoke('rec:chunk', recordingId, u8),
    finish: (payload) => invoke('rec:finish', payload),
    discard: (recordingId) => invoke('rec:discard', recordingId),
    state: (s) => send('rec:state', s)
  },
  recordings: {
    list: () => invoke('recordings:list'),
    remove: (id) => invoke('recording:delete', id),
    rename: (id, newName) => invoke('recording:rename', [id, newName]),
    reveal: (id) => invoke('recording:open', id),
    getFilePath: (id) => invoke('recording:path', id),
    pickFolder: () => invoke('recordings:folder-pick'),
    openFolder: () => invoke('recordings:folder-open'),
    onChanged: (cb) => on('recordings:changed', cb)
  },
  /* crash-recovery offers (§6.5 B4): ids are manifest session ids */
  recovery: {
    list: () => invoke('recovery:list'),
    recover: (id) => invoke('recovery:recover', id),
    del: (id) => invoke('recovery:delete', id),
    dismiss: (id) => invoke('recovery:dismiss', id)
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
    start: (recordingId) => send('app:drag-start', recordingId)
  },
  share: {
    apps: (payload) => invoke('share:apps', payload),
    launch: (payload) => invoke('share:launch', payload),
    openWith: (recordingId) => invoke('share:openwith', recordingId)
  },
  log: (...a) => send('app:log', a.map(String)),
  openExternal: (url) => send('app:open-external', url)
};

/* floating toolbar: button actions + state updates + logging only */
const bridgeFloating = {
  float: {
    action: (action) => send('float:action', String(action || '').slice(0, 32)),
    onState: (cb) => on('float:state', cb)
  },
  log: (...a) => send('app:log', a.map(String))
};

/* region picker: submit/cancel result + logging only */
const bridgeRegion = {
  region: {
    sendDone: (rect) => send('region:done', rect),
    sendCancel: () => send('region:cancel')
  },
  log: (...a) => send('app:log', a.map(String))
};

/* unexpected role → expose nothing (fail closed) */
const bridgeEmpty = {};

const bridge =
  ROLE === 'MAIN' ? bridgeFull :
  ROLE === 'FLOATING' ? bridgeFloating :
  ROLE === 'REGION' ? bridgeRegion :
  bridgeEmpty;

contextBridge.exposeInMainWorld('rekzora', bridge);
