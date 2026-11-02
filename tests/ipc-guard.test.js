'use strict';
/* Regression tests — centralized IPC guard (audit §5.4, §5.8).
   Sender identity (registered windows), role allowlists, main-frame
   requirement, trusted-URL checks, tiny schema, and role/channel parity
   with the preload bridge. */
const test = require('node:test');
const assert = require('node:assert');
const { ROLES, ROLE_CHANNELS, channelsForRole, GuardError, createGuard } = require('../lib/ipc-guard');

function fakeSender({ id = 7, destroyed = false, url = 'file:///app/src/renderer/index.html' } = {}) {
  return {
    id,
    isDestroyed: () => destroyed,
    getURL: () => url,
    isMainFrame: true
  };
}
const PREFIX = 'file:///app/';

function guardWith() {
  return createGuard({ trustedUrlPrefixes: [PREFIX] });
}

test('unregistered senders (devtools, foreign frames) are refused', () => {
  const g = guardWith();
  assert.throws(() => g.authorize(fakeSender({ id: 999 }), 'settings:get'), /not a registered Rekzora window/);
});

test('register → authorize happy path per role', () => {
  const g = guardWith();
  const wc = fakeSender({ id: 1 });
  g.register(wc, ROLES.MAIN);
  assert.strictEqual(g.authorize(wc, 'rec:begin').role, ROLES.MAIN);
  assert.strictEqual(g.roleOf(1), ROLES.MAIN);
});

test('destroyed sender refused', () => {
  const g = guardWith();
  const wc = fakeSender({ id: 2 });
  g.register(wc, ROLES.MAIN);
  assert.throws(() => g.authorize(fakeSender({ id: 2, destroyed: true }), 'rec:begin'), /destroyed/);
});

test('role-denied channels refused in both directions', () => {
  const g = guardWith();
  const f = fakeSender({ id: 10 });
  const r = fakeSender({ id: 11 });
  g.register(f, ROLES.FLOATING);
  g.register(r, ROLES.REGION);
  assert.throws(() => g.authorize(f, 'recording:delete'), /may not call/);
  assert.throws(() => g.authorize(r, 'settings:set'), /may not call/);
  assert.strictEqual(g.authorize(f, 'float:action').role, ROLES.FLOATING);
  assert.strictEqual(g.authorize(r, 'region:done').role, ROLES.REGION);
  /* floating/region may log, may not touch recording payloads */
  assert.strictEqual(g.authorize(f, 'app:log').role, ROLES.FLOATING);
  assert.throws(() => g.authorize(f, 'rec:chunk'), /may not call/);
});

test('revoked access cannot be restored by re-sending unless re-registered', () => {
  const g = guardWith();
  const wc = fakeSender({ id: 12 });
  g.register(wc, ROLES.MAIN);
  g.revoke(12);
  assert.throws(() => g.authorize(wc, 'rec:begin'), /not a registered/);
  g.register(wc, ROLES.MAIN); // explicit re-registration restores
  assert.strictEqual(g.roleOf(12), ROLES.MAIN);
});

test('untrusted URL (post navigation, remote content) is refused', () => {
  const g = guardWith();
  const wc = fakeSender({ id: 13, url: 'https://evil.example/index.html' });
  g.register(wc, ROLES.MAIN);
  assert.throws(() => g.authorize(wc, 'settings:get'), /not trusted/);
});

test('least privilege: region window can neither delete recordings nor launch share', () => {
  const g = guardWith();
  const wc = fakeSender({ id: 14 });
  g.register(wc, ROLES.REGION);
  for (const ch of ['recording:delete', 'share:launch', 'rec:finish', 'settings:set']) {
    assert.throws(() => g.authorize(wc, ch), GuardError);
  }
  /* but its own channels work */
  assert.strictEqual(g.authorize(wc, 'region:done').role, ROLES.REGION);
});

test('schema helper flags wrong types', () => {
  const g = guardWith();
  assert.throws(() => g.schema({ recordingId: 5 }, { recordingId: 'string' }), /must be a string/);
  assert.doesNotThrow(() => g.schema({ recordingId: 'ok' }, { recordingId: 'string' }));
  assert.doesNotThrow(() => g.schema({}, { anything: 'string' }), 'absent fields stay optional');
});

test('channelsForRole(WIN roles) lists least-privilege subsets', () => {
  const float = channelsForRole(ROLES.FLOATING);
  assert.ok(float.includes('float:action'));
  assert.ok(!float.includes('recording:delete'));
  const region = channelsForRole(ROLES.REGION);
  assert.ok(region.includes('region:done'));
  assert.ok(!region.includes('share:launch'));
});

/* ── parity: every channel the preload exposes for a role must be allowed ── */
test('PRELOAD ⇄ GUARD parity (role bridges never drift)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  const mainPool = src.match(/const CHANNELS_MAIN = \[([\s\S]*?)\];/)[1];
  const floatPool = src.match(/const CHANNELS_FLOATING = \[([\s\S]*?)\];/)[1];
  const regionPool = src.match(/const CHANNELS_REGION = \[([\s\S]*?)\];/)[1];
  const grab = (s) => (String(s).match(/'([a-z:-]+)'/g) || []).map((x) => x.slice(1, -1));

  for (const ch of grab(mainPool)) {
    assert.ok(ROLE_CHANNELS[ch], `preload MAIN channel ${ch} missing in lib/ipc-guard.js ROLE_CHANNELS`);
    assert.ok(ROLE_CHANNELS[ch].includes(ROLES.MAIN), `MAIN may not call ${ch} per guard`);
  }
  for (const ch of grab(floatPool)) {
    assert.ok(ROLE_CHANNELS[ch] && ROLE_CHANNELS[ch].includes(ROLES.FLOATING), `FLOATING channel ${ch}`);
  }
  for (const ch of grab(regionPool)) {
    assert.ok(ROLE_CHANNELS[ch] && ROLE_CHANNELS[ch].includes(ROLES.REGION), `REGION channel ${ch}`);
  }
  /* the send-only channels the bridges use must also be authorized for their roles */
  const sendSet = grab(src.match(/const SEND_CHANNELS = new Set\(\[([\s\S]*?)\]\)/)[1]);
  for (const ch of sendSet) {
    assert.ok(ROLE_CHANNELS[ch], `send channel ${ch} missing from ROLE_CHANNELS`);
    assert.ok(
      ROLE_CHANNELS[ch].some((r) => [
        grab(mainPool).includes(ch) && (r === ROLES.MAIN),
        grab(floatPool).includes(ch) || ['rec:state', 'app:window', 'app:quit', 'app:log', 'app:open-external', 'app:drag-start'].includes(ch) && r === ROLES.MAIN,
        grab(regionPool).includes(ch) || ['region:done', 'region:cancel', 'app:log'].includes(ch) && (r === ROLES.REGION),
        ['float:action', 'app:log'].includes(ch) && r === ROLES.FLOATING
      ].some(Boolean)),
      `send channel ${ch} has no authorizing role`
    );
  }
});
