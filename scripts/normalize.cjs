// Shared golden-fixture normalizers (design §8.4).
// Required by scripts/capture-golden.cjs and, from Phase 15, by test/helpers/normalize.ts.
// One implementation only — two copies drift, and a drifting normalizer is a
// silently passing contract test.

const normalize = (s) => s
  .replace(/----=_Part_[0-9a-f]{32}/g, '----=_Part_<BOUNDARY>')
  .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<BATCH_UUID>')
  .replace(/\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?Z?/g, '<TIMESTAMP>');

const normalizeJson = (v) => JSON.parse(normalize(JSON.stringify(v)));

module.exports = { normalize, normalizeJson };
