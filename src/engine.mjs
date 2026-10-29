// Scoring engine: factor z-scores -> gauges -> meter -> regime, trend and silver tilt.
import { GAUGES, FACTORS, ZONES, ALERTS } from '../config/factors.mjs';
import { fred, gpr, cotManagedMoney, gldHoldings, withCache } from './sources.mjs';
import { transform, combine, asOfIndex, zAt, rankAt, daysBetween, addDays, sma, round, iso } from './lib.mjs';

// ---------- loading ----------
const cache = new Map();
function loadSource(src) {
  const key = JSON.stringify(src);
  if (!cache.has(key)) {
    let p;
    if (src.type === 'fred') p = fred(src.id);
    else if (src.type === 'gpr') p = withCache(`gpr-${src.column}`, () => gpr(src.column));
    else if (src.type === 'gld') p = withCache('gld', gldHoldings);
    else if (src.type === 'cot') p = withCache(`cot-${src.code}`, () => cotManagedMoney(src.code));
    else if (src.type === 'spread') p = Promise.all([fred(src.a), fred(src.b)]).then(([a, b]) => combine(a, b, (x, y) => x - y));
    else p = Promise.reject(new Error(`unknown source ${src.type}`));
    cache.set(key, p);
  }
  return cache.get(key);
}

export async function loadFactors(factors = FACTORS) {
  const out = {};
  await Promise.all(factors.map(async f => {
    try {
      const raw = await loadSource(f.source);
      out[f.id] = { raw, tx: transform(raw, f.transform) };
    } catch (err) {
      out[f.id] = { raw: [], tx: [], error: err.message };
    }
  }));
  return out;
}

export async function loadDisplay(display) {
  const out = {};
  await Promise.all(Object.entries(display).map(async ([k, d]) => {
    try { out[k] = await loadSource(d.source); } catch (err) { out[k] = { error: err.message }; }
  }));
  return out;
}

// ---------- scoring ----------
// live=true  -> use the latest observation available now
// live=false -> back-fill: only use observations that were published by `date`
export function scoreAt(data, date, { live = false, factors = FACTORS } = {}) {
  const fScores = {};
  for (const f of factors) {
    const s = data[f.id]?.tx ?? [];
    const idx = live ? s.length - 1 : asOfIndex(s, addDays(date, -(f.lagDays ?? 1)));
    if (idx < 0) { fScores[f.id] = { score: null, error: data[f.id]?.error ?? 'no data' }; continue; }
    const z = zAt(s, idx, f.window);
    const rank = rankAt(s, idx, f.window);
    const age = daysBetween(s[idx].d, date);
    fScores[f.id] = {
      value: s[idx].v, asOf: s[idx].d, z,
      score: rank === null ? null : 100 * (f.dir > 0 ? rank : 1 - rank),
      stale: age > f.maxAgeDays, ageDays: age,
    };
  }

  const gauges = {};
  for (const [g, G] of Object.entries(GAUGES)) {
    const members = factors.filter(f => f.gauge === g);
    let wSum = 0, sSum = 0, covered = 0, total = 0;
    for (const f of members) {
      total += f.weight;
      const r = fScores[f.id];
      if (r.score === null) continue;
      const w = f.weight * (r.stale ? 0.5 : 1);
      wSum += w; sSum += w * r.score; covered += f.weight;
    }
    gauges[g] = { score: wSum ? sSum / wSum : null, coverage: total ? covered / total : 0 };
  }

  // Liquidity gate: in a credit crunch the fear bid is halved (dash for cash).
  const gate = fScores.hy?.score ?? null;
  const stressed = gate !== null && gate >= ALERTS.liquidityGate;
  if (stressed && gauges.fear.score !== null) gauges.fear.raw = gauges.fear.score, gauges.fear.score = 50 + (gauges.fear.score - 50) * 0.5;

  let mW = 0, mS = 0;
  for (const [g, G] of Object.entries(GAUGES)) {
    const s = gauges[g].score;
    if (s === null) continue;
    const w = G.weight * gauges[g].coverage;
    mW += w; mS += w * (G.effect > 0 ? s : 100 - s);
  }
  const meter = mW ? mS / mW : null;
  const coverage = mW / Object.values(GAUGES).reduce((a, G) => a + G.weight, 0);
  return { date, meter, coverage, gauges, gate: { score: gate, stressed }, factors: fScores };
}

export const zoneOf = (m, prevKey = null, hysteresis = 0) => {
  const idx = ZONES.findIndex(z => m < z.max);
  if (prevKey && hysteresis) {
    const pi = ZONES.findIndex(z => z.key === prevKey);
    if (pi < 0) return ZONES[idx];
    // only leave the previous zone once the meter clears its edge by `hysteresis` points
    const lo = pi > 0 ? ZONES[pi - 1].max : -Infinity, hi = ZONES[pi].max;
    if (m >= lo - hysteresis && m < hi + hysteresis) return ZONES[pi];
  }
  return ZONES[idx];
};

// ---------- gold trend, silver tilt and the trade read ----------
export function trend(series) {
  if (!series || series.length < 1) return null;
  const i = series.length - 1;
  const px = series[i].v;
  const s50 = sma(series, 50), s200 = sma(series, 200);
  const r20 = series.length > 20 ? (px / series[i - 20].v - 1) * 100 : null;
  let state = 'unknown';
  if (s50 && s200) state = px > s50 && s50 > s200 ? 'up' : px < s50 && s50 < s200 ? 'down' : 'mixed';
  else if (s50) state = px > s50 ? 'up' : 'down';
  return { price: px, asOf: series[i].d, sma50: s50, sma200: s200, ret20: r20, state, points: series.length };
}

export function tradeRead(meter, gauges, goldTrend, tugLevel = 65, gate = {}) {
  const t = goldTrend?.state ?? 'unknown';
  const fear = gauges.fear.raw ?? gauges.fear.score ?? 50, head = gauges.headwind.score ?? 50;
  const flags = [];
  if (gate.stressed) flags.push('liquidity_stress');
  if (fear >= tugLevel && head >= tugLevel) flags.push('tug_of_war');
  if (meter >= 60 && t === 'down') flags.push('divergence');

  let bias, text;
  if (flags.includes('liquidity_stress')) {
    bias = 'caution';
    text = 'Credit stress: in a dash for cash gold can fall alongside stocks before its safe-haven bid returns. Wait for credit spreads to stop widening.';
  } else if (flags.includes('tug_of_war')) {
    bias = 'caution';
    text = 'Tug-of-war: war fear is lifting gold while a hawkish Fed and rising yields push back. Expect sharp two-way swings; size down and trade the range.';
  } else if (meter >= 60 && t === 'up') {
    bias = 'bullish';
    text = 'Tailwind aligned: safe-haven demand is high and gold is trending up. Dips toward the 50-day average are the higher-quality entries.';
  } else if (meter >= 60 && t === 'down') {
    bias = 'caution';
    text = 'Divergence: fear is high but gold is not responding, usually because rates or the dollar dominate. Wait for price to reclaim its 50-day average.';
  } else if (meter <= 40 && t === 'down') {
    bias = 'bearish';
    text = 'Headwind aligned: little safe-haven demand and gold trending down. Avoid fresh longs; rallies are more likely to fade.';
  } else if (meter <= 40 && t === 'up') {
    bias = 'caution';
    text = 'Gold is rising without macro support, a momentum-only move. Keep stops tight.';
  } else {
    bias = 'neutral';
    text = 'No strong macro edge. Let price structure lead.';
  }
  return { bias, text, flags };
}

export function silverTilt(gold, silver, meter) {
  if (!gold?.length || !silver?.length) return null;
  const ratio = combine(gold, silver, (g, s) => g / s);
  if (!ratio.length) return null;
  const now = ratio[ratio.length - 1].v;
  const prev = ratio.length > 20 ? ratio[ratio.length - 21].v : null;
  const chg = prev ? now - prev : null;
  let text = 'Not enough history yet.';
  if (chg !== null) {
    if (chg > 0 && meter >= 55) text = 'Ratio rising with high fear: panic favours gold over silver.';
    else if (chg < 0) text = 'Ratio falling: silver is outperforming (industrial or reflation demand); silver offers higher beta.';
    else text = 'Ratio rising in calm conditions: silver lagging; gold the steadier choice.';
  }
  return { ratio: now, chg20: chg, text };
}

// ---------- history back-fill ----------
export function backfill(data, days = 400, goldSeries = []) {
  const end = iso(Date.now());
  const out = [];
  for (let k = days; k >= 0; k--) {
    const d = addDays(end, -k);
    const wd = new Date(d).getUTCDay();
    if (wd === 0 || wd === 6) continue;
    const r = scoreAt(data, d);
    if (r.meter === null) continue;
    const gi = asOfIndex(goldSeries, d);
    out.push({
      d, meter: round(r.meter, 1),
      fear: round(r.gauges.fear.score, 1), inflation: round(r.gauges.inflation.score, 1),
      headwind: round(r.gauges.headwind.score, 1), flows: round(r.gauges.flows.score, 1),
      gold: gi >= 0 ? goldSeries[gi].v : null,
    });
  }
  return out;
}
