const { test } = require('node:test');
const assert = require('node:assert/strict');
const { formatRelayOutput } = require('../out/relayLog');

test('single-line relay output stays on the prefix line', () => {
  assert.equal(formatRelayOutput('[relay]', Buffer.from('Relay running\n')), '[relay] Relay running');
});

test('multi-line output (QR code) starts on its own line so rows stay aligned', () => {
  const qr = '▄▄▄▄▄\n█ ▄ █\n▀▀▀▀▀\n';
  assert.equal(formatRelayOutput('[relay]', Buffer.from(qr)), '[relay]\n▄▄▄▄▄\n█ ▄ █\n▀▀▀▀▀');
});
