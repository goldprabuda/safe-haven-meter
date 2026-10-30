// Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { transform, rankAt, combine } from '../src/lib.mjs';
import { zoneOf, tradeRead, scoreAt, fedRegime } from '../src/engine.mjs';
import { FACTORS } from '../config/factors.mjs';

const S = pairs => pairs.map(([d, v]) => ({ d, v }));

test('year-on-year matches by date across a missing month', () => {
  // Oct-2025 CPI was never published (shutdown). Row-offset YoY would be wrong here.
  const s = S([['2024-09-01', 100], ['2024-10-01', 101], ['2024-11-01', 102], ['2025-09-01', 103], ['2025-11-01', 105], ['2026-09-01', 110]]);
  const y = transform(s, { kind: 'yoy' });
  assert.deepEqual(y.map(p => p.d), ['2025-09-01', '2025-11-01', '2026-09-01']);
  assert.ok(Math.abs(y[1].v - (105 / 102 - 1) * 100) < 1e-9, 'Nov-25 compares with Nov-24');
});

test('percentile rank: latest max = ~100%, latest min = ~0%', () => {
  const up = S(Array.from({ length: 50 }, (_, i) => [`2026-01-${String(i + 1).padStart(2, '0')}`, i]));
  assert.ok(rankAt(up, 49, 50) > 0.98);
  const down = up.map((p, i) => ({ d: p.d, v: 50 - i }));
  assert.ok(rankAt(down, 49, 50) < 0.02);
  assert.equal(rankAt(up, 10, 50), null, 'too little history returns null');
});

test('spread carries the slower series forward', () => {
  const a = S([['2026-01-01', 4.5], ['2026-01-02', 4.6], ['2026-01-03', 4.7]]);
  const b = S([['2026-01-01', 4.0]]);
  assert.deepEqual(combine(a, b, (x, y) => +(x - y).toFixed(2)).map(p => p.v), [0.5, 0.6, 0.7]);
});

test('zone hysteresis holds the zone near an edge', () => {
  assert.equal(zoneOf(76).key, 'haven');
  assert.equal(zoneOf(74, 'haven', 3).key, 'haven', 'within 3 pts of the 75 edge: stay');
  assert.equal(zoneOf(71, 'haven', 3).key, 'elevated', 'cleared the buffer: flip');
});

test('trade read flags tug-of-war, divergence and credit stress', () => {
  const g = (fear, headwind) => ({ fear: { score: fear }, headwind: { score: headwind } });
  assert.ok(tradeRead(55, g(80, 80), { state: 'up' }).flags.includes('tug_of_war'));
  assert.equal(tradeRead(70, g(70, 30), { state: 'up' }).bias, 'bullish');
  assert.ok(tradeRead(70, g(70, 30), { state: 'down' }).flags.includes('divergence'));
  assert.equal(tradeRead(30, g(30, 70), { state: 'down' }).bias, 'bearish');
  assert.equal(tradeRead(60, g(80, 30), { state: 'up' }, 65, { stressed: true }).bias, 'caution');
});

// Synthetic data: every factor's latest value is its all-time high (rank ~100),
// so fear, inflation, headwind and flows all read ~100 before gates.
function hotData(overrides = {}) {
  const days = Array.from({ length: 300 }, (_, i) => new Date(Date.UTC(2025, 0, 1) + i * 864e5).toISOString().slice(0, 10));
  const rising = days.map((d, i) => ({ d, v: i / 100 }));
  const data = {};
  for (const f of FACTORS) data[f.id] = { tx: overrides[f.id] ? overrides[f.id](days) : rising };
  return { data, date: days.at(-1) };
}
const flat = v => days => days.map(d => ({ d, v }));
const calmCredit = days => days.map((d, i) => ({ d, v: 300 - i }));   // spread falling -> rank ~0

test('liquidity gate halves the fear bid when credit spreads are extreme', () => {
  const { data, date } = hotData({ fed_path: flat(0), y2_60: flat(0) });
  const r = scoreAt(data, date, { live: true });
  assert.equal(r.gate.stressed, true);
  assert.equal(r.regime, 'neutral');
  assert.ok(Math.abs(r.gauges.fear.score - (50 + (r.gauges.fear.raw - 50) * 0.5)) < 1e-9);
});

test('Fed regime: enter, hold with hysteresis, exit, easing', () => {
  assert.equal(fedRegime(0.30, 0.0, 'neutral'), 'tightening', 'hikes priced');
  assert.equal(fedRegime(0.0, 0.30, 'neutral'), 'tightening', '2y up 30bp in 60 days');
  assert.equal(fedRegime(0.20, 0.0, 'tightening'), 'tightening', 'between exit and enter: hold');
  assert.equal(fedRegime(0.20, 0.0, 'neutral'), 'neutral', 'between exit and enter: no entry');
  assert.equal(fedRegime(0.10, 0.10, 'tightening'), 'neutral', 'both below exit: leave');
  assert.equal(fedRegime(-0.30, -0.05, 'neutral'), 'easing', 'cuts priced, 2y not rising');
  assert.equal(fedRegime(-0.30, 0.10, 'neutral'), 'neutral', 'cuts priced but 2y rising: not easing');
  assert.equal(fedRegime(null, null, 'tightening'), 'tightening', 'missing data keeps regime');
});

test('Fed tightening halves fear and flips inflation to count against gold', () => {
  const { data, date } = hotData({ hy: calmCredit, fed_path: flat(0.6), y2_60: flat(0.4) });
  const tight = scoreAt(data, date, { live: true });
  assert.equal(tight.regime, 'tightening');
  assert.equal(tight.gate.stressed, false);
  assert.equal(tight.gauges.fear.mult, 0.5);
  assert.equal(tight.gauges.inflation.effect, -1);

  const { data: d2 } = hotData({ hy: calmCredit, fed_path: flat(0), y2_60: flat(0) });
  const normal = scoreAt(d2, date, { live: true });
  assert.equal(normal.regime, 'neutral');
  assert.equal(normal.gauges.inflation.effect, 1);
  assert.ok(tight.meter < normal.meter, `hot inflation lowers the meter when tightening (${tight.meter.toFixed(1)} < ${normal.meter.toFixed(1)})`);
});

test('both gates together cut fear to a quarter', () => {
  const { data, date } = hotData({ fed_path: flat(0.6), y2_60: flat(0.4) });
  const r = scoreAt(data, date, { live: true });
  assert.equal(r.gate.stressed, true);
  assert.equal(r.gauges.fear.mult, 0.25);
});

test('war fear during tightening reads caution, not bullish', () => {
  const g = { fear: { score: 60, raw: 85 }, headwind: { score: 40 } };
  const r = tradeRead(70, g, { state: 'up' }, 65, {}, 'tightening');
  assert.equal(r.bias, 'caution');
  assert.ok(r.flags.includes('war_vs_fed') && r.flags.includes('fed_tightening'));
});
