'use strict';
// Pure defaulting logic for the expressive (Chatterbox-class) generation params, split out of
// main.js so it's unit-testable without pulling in Electron (main.js is the app entry point and
// can't be require()'d directly). Defaults are the by-ear-tuned config the user landed on.

const EXPRESSIVE_DEFAULTS = {
  exaggeration: 0.5,
  cfgWeight: 0.3,
  temperature: 0.75,
  speedFactor: 1.0,
};

// Merge renderer-sent overrides with the tuned defaults: each provided (non-null/undefined,
// finite-number) opt wins; anything else (missing, null, NaN, non-numeric) falls back.
function mergeExpressiveParams(opts) {
  const o = opts || {};
  const pick = (v, d) => (v != null && Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    exaggeration: pick(o.exaggeration, EXPRESSIVE_DEFAULTS.exaggeration),
    cfgWeight: pick(o.cfgWeight, EXPRESSIVE_DEFAULTS.cfgWeight),
    temperature: pick(o.temperature, EXPRESSIVE_DEFAULTS.temperature),
    speedFactor: pick(o.speedFactor, EXPRESSIVE_DEFAULTS.speedFactor),
  };
}

module.exports = { EXPRESSIVE_DEFAULTS, mergeExpressiveParams };
