'use strict';
// Compare the exact preference values admitted by the fresh task baseline.
// This does not choose gameplay settings or write the preferences file.
function verify(text, expected) {
  const scalar = value => typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\x00-\x1f\x7f]/.test(value);
  if (typeof text !== 'string' || !expected || !scalar(expected.section)
      || !scalar(expected.AirDashCount) || !scalar(expected.AirJumpCount)) throw Error('FRESH_PREFERENCE_VALUES_REQUIRED');
  const found = new Map(); let section = null;
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const value = line.trim();
    if (!value || value.startsWith(';') || value.startsWith('#')) continue;
    const heading = /^\[([^\]]+)\]$/.exec(value);
    if (heading) { section = heading[1]; continue; }
    if (section !== expected.section) continue;
    const setting = /^([^=]+)=(.*)$/.exec(value);
    if (!setting) continue;
    const key = setting[1].trim(); if (!['AirDashCount', 'AirJumpCount'].includes(key)) continue;
    if (found.has(key)) throw Error('DUPLICATE_MYW_PREFERENCE');
    found.set(key, setting[2].trim());
  }
  for (const key of ['AirDashCount', 'AirJumpCount'])
    if (found.get(key) !== expected[key]) throw Error('FRESH_PREFERENCE_VALUES_CHANGED');
  return { section: expected.section, AirDashCount: expected.AirDashCount, AirJumpCount: expected.AirJumpCount, changed: false };
}
module.exports = { verify };
