'use strict';
/* ============================== ipc-guard.js ==============================
   Rekzora — centralized IPC sender authorization (main process).

   Every privileged IPC handler is wrapped by this guard. The guard keeps
   the main-process registry of Rekzora windows and their roles, and
   refuses any channel invocation whose sender:
     - is not a registered Rekzora WebContents (devtools, iframes, ...)
     - does not carry a role permitted for the channel
     - is not the main frame of its window
     - does not sit on a trusted app:// file URL (post-navigation checks)
     - passes a payload that fails the channel's tiny schema (optional)

   Roles are the least-privilege model from the security plan:
       MAIN     — main application window
       FLOATING — recording toolbar
       REGION   — region picker overlay
       PLAYER   — (future) dedicated playback window
   ========================================================================= */

const ROLES = Object.freeze({
  MAIN: 'MAIN',
  FLOATING: 'FLOATING',
  REGION: 'REGION',
  PLAYER: 'PLAYER'
});

/** Channel → roles allowed to invoke/send. Keep in sync with preload.js;
 *  tests/preload-role-parity.test.js fails the suite if they drift. */
const ROLE_CHANNELS = Object.freeze({
  /* MAIN window feature surface */
  'settings:get': [ROLES.MAIN],
  'settings:set': [ROLES.MAIN],
  'sources:get': [ROLES.MAIN],
  'capture:select-source': [ROLES.MAIN],
  'screen:primary-fast': [ROLES.MAIN],
  'recordings:list': [ROLES.MAIN],
  'recording:delete': [ROLES.MAIN],
  'recording:rename': [ROLES.MAIN],
  'recording:open': [ROLES.MAIN],
  'recording:path': [ROLES.MAIN],
  'recordings:folder-pick': [ROLES.MAIN],
  'recordings:folder-open': [ROLES.MAIN],
  'region:begin': [ROLES.MAIN],
  'region:get-bounds': [ROLES.MAIN],
  'float:show': [ROLES.MAIN],
  'float:hide': [ROLES.MAIN],
  'app:version': [ROLES.MAIN, ROLES.FLOATING, ROLES.REGION],
  'app:clipboard-write': [ROLES.MAIN],
  'share:apps': [ROLES.MAIN],
  'share:launch': [ROLES.MAIN],
  'share:openwith': [ROLES.MAIN],
  'recovery:list': [ROLES.MAIN],
  'recovery:recover': [ROLES.MAIN],
  'recovery:delete': [ROLES.MAIN],
  'recovery:dismiss': [ROLES.MAIN],
  'playback:url': [ROLES.MAIN],
  /* recording data pipeline: begin/chunk/finish/discard are invoked with the
     recorder's own session ownership on top of the role check */
  'rec:begin': [ROLES.MAIN, ROLES.PLAYER],
  'rec:chunk': [ROLES.MAIN, ROLES.PLAYER],
  'rec:finish': [ROLES.MAIN, ROLES.PLAYER],
  'rec:discard': [ROLES.MAIN, ROLES.PLAYER],
  /* fire-and-forget channels (ipcMain.on) */
  'rec:state': [ROLES.MAIN, ROLES.PLAYER],
  'float:action': [ROLES.FLOATING],
  'region:done': [ROLES.REGION],
  'region:cancel': [ROLES.REGION],
  'app:window': [ROLES.MAIN],
  'app:quit': [ROLES.MAIN],
  'app:log': [ROLES.MAIN, ROLES.FLOATING, ROLES.REGION],
  'app:open-external': [ROLES.MAIN],
  'app:drag-start': [ROLES.MAIN]
});

class GuardError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'GuardError';
    this.code = code;
  }
}

function channelsForRole(role) {
  return Object.keys(ROLE_CHANNELS).filter((ch) => ROLE_CHANNELS[ch].includes(role));
}

/**
 * @param {{trustedUrlPrefixes: string[], logger?: Function}} options
 *   trustedUrlPrefixes — e.g. [pathToFileURL(appRoot).href + '/']
 *   (fill() supply this; here it is injected for testability)
 */
function createGuard(options = {}) {
  const trusted = [...(options.trustedUrlPrefixes || [])];
  const logger = options.logger || (() => {});

  /** wcId → { role, revoked } */
  const registry = new Map();

  function register(webContents, role) {
    if (!webContents || typeof webContents.isDestroyed !== 'function') {
      throw new GuardError('BAD_REGISTRATION', 'register() needs a webContents');
    }
    if (!Object.values(ROLES).includes(role)) {
      throw new GuardError('BAD_ROLE', `unknown window role ${role}`);
    }
    registry.set(webContents.id, { role, revoked: false });
    if (typeof webContents.once === 'function') {
      try { webContents.once('destroyed', () => registry.delete(webContents.id)); } catch { /* */ }
    }
    return () => registry.delete(webContents.id);
  }

  function revoke(webContentsId) {
    const entry = registry.get(webContentsId);
    if (entry) entry.revoked = true;
  }

  function roleOf(webContentsId) {
    const entry = registry.get(webContentsId);
    if (!entry || entry.revoked) return null;
    return entry.role;
  }

  function urlTrusted(sender) {
    try {
      const url = (sender && sender.getURL && sender.getURL()) || '';
      if (!trusted.length) return false;
      return trusted.some((p) => url === p || url.startsWith(p));
    } catch {
      return false;
    }
  }

  /** authorize(sender, 'channel') → { role } | throws GuardError */
  function authorize(sender, channel) {
    if (!sender) throw new GuardError('NO_SENDER', 'missing sender');
    if (sender.isDestroyed && sender.isDestroyed()) {
      throw new GuardError('SENDER_DESTROYED', 'sender webContents is destroyed');
    }
    const role = roleOf(sender.id);
    if (!role) {
      throw new GuardError('SENDER_UNREGISTERED', `webContents ${sender ? sender.id : '?'} is not a registered Rekzora window`);
    }
    const allowed = ROLE_CHANNELS[channel];
    if (!allowed) {
      throw new GuardError('UNKNOWN_CHANNEL', `channel ${channel} is not part of the Rekzora IPC surface`);
    }
    if (!allowed.includes(role)) {
      throw new GuardError('ROLE_DENIED', `role ${role} may not call ${channel}`);
    }
    if (sender.isMainFrame !== undefined && sender.isMainFrame === false && sender.frame && !sender.frame.isMainFrame) {
      throw new GuardError('FRAME_DENIED', 'subframe senders are not authorized');
    }
    if (!urlTrusted(sender)) {
      throw new GuardError('URL_DENIED', `sender URL is not trusted app content: ${String(sender.getURL ? sender.getURL() : '').slice(0, 80)}`);
    }
    return { role };
  }

  /* tiny schema checker used by handlers for payload fields */
  function schema(payload, rules) {
    /* rules: { field: 'string'|'number'|'boolean'|'object'|'buffer'|'any' }  */
    for (const [field, kind] of Object.entries(rules || {})) {
      const v = payload?.[field];
      const present = payload !== null && payload !== undefined && field in payload;
      if (!present) continue;                       // optional by default
      if (kind === 'any') continue;
      if (kind === 'string' && typeof v !== 'string') throw new GuardError('SCHEMA', `${field} must be a string`);
      if (kind === 'number' && typeof v !== 'number') throw new GuardError('SCHEMA', `${field} must be a number`);
      if (kind === 'boolean' && typeof v !== 'boolean') throw new GuardError('SCHEMA', `${field} must be a boolean`);
      if (kind === 'object' && (typeof v !== 'object' || v === null)) throw new GuardError('SCHEMA', `${field} must be an object`);
      if (kind === 'buffer' && !Buffer.isBuffer(v)) throw new GuardError('SCHEMA', `${field} must be binary`);
    }
    return true;
  }

  /** Wrap a handle() so guard + logging happen before the real work. */
  function protectedHandle(ipcMainObj, channel, handler) {
    ipcMainObj.handle(channel, async (event, ...args) => {
      const { role } = authorize(event.sender, channel);
      try {
        return await handler(event, args, role);
      } catch (e) {
        if (e instanceof GuardError) throw e;
        throw e;
      }
    });
  }

  function stats() {
    return { windows: registry.size, roles: [...registry.values()].map((e) => e.role) };
  }

  return {
    ROLES, ROLE_CHANNELS, GuardError,
    register, revoke, roleOf, authorize, urlTrusted, schema,
    protectedHandle, channelsForRole, stats
  };
}

module.exports = { ROLES, ROLE_CHANNELS, channelsForRole, GuardError, createGuard };
