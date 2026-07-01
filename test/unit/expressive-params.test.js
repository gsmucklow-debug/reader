'use strict';
// Guards the expressive generation-param defaulting: the Voice-panel sliders send only the
// params the user has touched, and any omitted/invalid value must fall back to the by-ear-tuned
// default rather than becoming NaN/undefined on the wire to the Chatterbox server.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EXPRESSIVE_DEFAULTS, mergeExpressiveParams } = require('../../src/main/expressive-params');

test('mergeExpressiveParams fills in the tuned defaults when nothing is provided', () => {
  assert.deepStrictEqual(mergeExpressiveParams(), EXPRESSIVE_DEFAULTS);
  assert.deepStrictEqual(mergeExpressiveParams({}), EXPRESSIVE_DEFAULTS);
  assert.deepStrictEqual(mergeExpressiveParams(null), EXPRESSIVE_DEFAULTS);
});

test('mergeExpressiveParams lets provided numeric overrides win, one at a time', () => {
  assert.strictEqual(mergeExpressiveParams({ exaggeration: 1.1 }).exaggeration, 1.1);
  assert.strictEqual(mergeExpressiveParams({ cfgWeight: 0.6 }).cfgWeight, 0.6);
  assert.strictEqual(mergeExpressiveParams({ temperature: 0.9 }).temperature, 0.9);
  assert.strictEqual(mergeExpressiveParams({ speedFactor: 1.25 }).speedFactor, 1.25);
});

test('mergeExpressiveParams overrides all four together', () => {
  const merged = mergeExpressiveParams({ exaggeration: 1, cfgWeight: 0.8, temperature: 0.6, speedFactor: 1.4 });
  assert.deepStrictEqual(merged, { exaggeration: 1, cfgWeight: 0.8, temperature: 0.6, speedFactor: 1.4 });
});

test('mergeExpressiveParams falls back on invalid values (null, undefined, NaN, non-numeric)', () => {
  assert.strictEqual(mergeExpressiveParams({ exaggeration: null }).exaggeration, EXPRESSIVE_DEFAULTS.exaggeration);
  assert.strictEqual(mergeExpressiveParams({ exaggeration: undefined }).exaggeration, EXPRESSIVE_DEFAULTS.exaggeration);
  assert.strictEqual(mergeExpressiveParams({ exaggeration: NaN }).exaggeration, EXPRESSIVE_DEFAULTS.exaggeration);
  assert.strictEqual(mergeExpressiveParams({ exaggeration: 'not-a-number' }).exaggeration, EXPRESSIVE_DEFAULTS.exaggeration);
});

test('mergeExpressiveParams coerces numeric strings (range input values arrive as strings)', () => {
  assert.strictEqual(mergeExpressiveParams({ cfgWeight: '0.45' }).cfgWeight, 0.45);
});
