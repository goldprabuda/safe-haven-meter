// Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { transform, rankAt, combine } from '../src/lib.mjs';
import { zoneOf, tradeRead, scoreAt } from '../src/engine.mjs';
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

test('liquidity gate halves the fear bid when credit spreads are extreme', () => {
  const days = Array.from({ length: 300 }, (_, i) => new Date(Date.UTC(2025, 0, 1) + i * 864e5).toISOString().slice(0, 10));
  const rising = days.map((d, i) => ({ d, v: i }));          // latest value = all-time high -> rank ~100
  const data = {};
  for (const f of FACTORS) data[f.id] = { tx: transform(rising, f.gauge === 'gate' ? { kind: 'level' } : { kind: 'level' }) };
  const r = scoreAt(data, days.at(-1), { live: true });
  assert.equal(r.gate.stressed, true);
  assert.ok(r.gauges.fear.score < r.gauges.fear.raw, 'fear pulled toward 50');
  assert.ok(Math.abs(r.gauges.fear.score - (50 + (r.gauges.fear.raw - 50) / 2)) < 1e-9);
});
