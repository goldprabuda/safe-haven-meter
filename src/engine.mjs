// Scoring engine: factor z-scores -> gauges -> meter -> regime, trend and silver tilt.
import { GAUGES, FACTORS, ZONES, GATES } from '../config/factors.mjs';
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
export function scoreAt(data, date, { live = false, factors = FACTORS, prevRegime = 'neutral' } = {}) {
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

  // ---- Gates (see GATES in config) ----
  const gate = fScores.hy?.score ?? null;
  const stressed = gate !== null && gate >= GATES.liquidity.rank;
  const regime = fedRegime(fScores.fed_path?.value, fScores.y2_60?.value, prevRegime);

  let fearMult = 1;
  if (stressed) fearMult *= GATES.liquidity.fearMult;
  if (regime === 'tightening') fearMult *= GATES.fed.fearMult;
  if (fearMult < 1 && gauges.fear.score !== null) {
    gauges.fear.raw = gauges.fear.score;
    gauges.fear.score = 50 + (gauges.fear.score - 50) * fearMult;
  }
  gauges.fear.mult = fearMult;

  const effect = {};
  for (const [g, G] of Object.entries(GAUGES)) effect[g] = G.effect;
  if (regime === 'tightening') effect.inflation = GATES.fed.inflationEffect;
  for (const g of Object.keys(GAUGES)) gauges[g].effect = effect[g];

  let mW = 0, mS = 0;
  for (const [g, G] of Object.entries(GAUGES)) {
    const s = gauges[g].score;
    if (s === null) continue;
    const w = G.weight * gauges[g].coverage;
    mW += w; mS += w * (effect[g] > 0 ? s : 100 - s);
  }
  const meter = mW ? mS / mW : null;
  const coverage = mW / Object.values(GAUGES).reduce((a, G) => a + G.weight, 0);
  return { date, meter, coverage, gauges, regime, gate: { score: gate, stressed }, factors: fScores };
}

// Fed regime from market pricing, with hysteresis. Returns 'tightening' | 'easing' | 'neutral'.
// Unknown inputs keep the previous regime (or neutral).
export function fedRegime(path, trend60, prev = 'neutral') {
  const T = GATES.fed.tighten, E = GATES.fed.ease;
  const p = Number.isFinite(path) ? path : null, t = Number.isFinite(trend60) ? trend60 : null;
  if (p === null && t === null) return prev ?? 'neutral';
  if (prev === 'tightening') {
    const stillTight = (p !== null && p > T.exitPath) || (t !== null && t > T.exitTrend);
    if (stillTight) return 'tightening';
  } else if ((p !== null && p > T.enterPath) || (t !== null && t > T.enterTrend)) {
    return 'tightening';
  }
  // Easing: cuts priced and the 2y not rising. Once in, a small 2y bounce (< exitTrend) doesn't end it.
  if (prev === 'easing' && p !== null && p < E.exitPath && (t === null || t < E.exitTrend)) return 'easing';
  if (p !== null && p < E.enterPath && (t === null || t <= 0)) return 'easing';
  return 'neutral';
}

export const REGIME_TEXT = {
  tightening: { label: 'Fed tightening', text: 'Hikes are priced. War fear counts half, and hot inflation now counts against gold because it means more hikes.' },
  easing: { label: 'Fed easing', text: 'Cuts are priced. Fear and inflation both count fully for gold.' },
  neutral: { label: 'Fed on hold', text: 'No clear rate path priced. Gauges count normally.' },
};

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

export function tradeRead(meter, gauges, goldTrend, tugLevel = 65, gate = {}, regime = 'neutral') {
  const t = goldTrend?.state ?? 'unknown';
  const fear = gauges.fear.raw ?? gauges.fear.score ?? 50, head = gauges.headwind.score ?? 50;
  const flags = [];
  if (regime === 'tightening') flags.push('fed_tightening');
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
  } else if (regime === 'tightening' && fear >= tugLevel) {
    bias = 'caution';
    flags.push('war_vs_fed');
    text = 'War fear is high but the Fed is tightening. In 2026 escalation pushed oil, yields and the dollar up and gold down, while oil relief lifted gold. Don\'t buy the headline; wait for price to confirm.';
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
  let regime = 'neutral';
  for (let k = days; k >= 0; k--) {
    const d = addDays(end, -k);
    const wd = new Date(d).getUTCDay();
    if (wd === 0 || wd === 6) continue;
    const r = scoreAt(data, d, { prevRegime: regime });
    regime = r.regime;
    if (r.meter === null) continue;
    const gi = asOfIndex(goldSeries, d);
    out.push({
      d, meter: round(r.meter, 1),
      fear: round(r.gauges.fear.score, 1), inflation: round(r.gauges.inflation.score, 1),
      headwind: round(r.gauges.headwind.score, 1), flows: round(r.gauges.flows.score, 1),
      regime: r.regime[0],                       // t / e / n
      gold: gi >= 0 ? goldSeries[gi].v : null,
    });
  }
  return out;
}
