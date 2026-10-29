// Shared helpers: HTTP with retry, series transforms, statistics.
// A "series" is always an ascending array of { d: 'YYYY-MM-DD', v: number }.

export async function http(url, { as = 'text', retries = 2, timeoutMs = 20000, headers = {}, backoffMs = 1500 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { fatal: true });
      if (as === 'json') return await res.json();
      if (as === 'buffer') return Buffer.from(await res.arrayBuffer());
      return await res.text();
    } catch (err) {
      lastErr = err;
      if (err.fatal || attempt === retries) break;
      await new Promise(r => setTimeout(r, backoffMs * 2 ** attempt));
    }
  }
  throw new Error(`${url.split('?')[0]} -> ${lastErr?.message}`);
}

export const iso = d => new Date(d).toISOString().slice(0, 10);
export const daysBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 864e5);
export const addDays = (d, n) => iso(new Date(new Date(d).getTime() + n * 864e5));

export function clean(series) {
  const seen = new Map();
  for (const p of series) if (p && p.d && Number.isFinite(p.v)) seen.set(p.d, p.v);
  return [...seen.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([d, v]) => ({ d, v }));
}

// Transforms turn a raw series into the quantity the meter actually scores.
export function transform(series, t = { kind: 'level' }) {
  const s = clean(series);
  const n = t.n ?? 1;
  switch (t.kind) {
    case 'level': return s;
    case 'chg': return s.slice(n).map((p, i) => ({ d: p.d, v: p.v - s[i].v }));
    case 'pct': return s.slice(n).map((p, i) => ({ d: p.d, v: s[i].v ? (p.v / s[i].v - 1) * 100 : NaN })).filter(p => Number.isFinite(p.v));
    // Year-on-year by DATE, not by row: FRED has gaps (e.g. Oct-2025 CPI was never
    // published because of the government shutdown), so "12 rows back" can be 13 months.
    case 'yoy': {
      const out = [];
      for (const p of s) {
        const prior = new Date(p.d); prior.setUTCFullYear(prior.getUTCFullYear() - 1);
        const j = asOfIndex(s, iso(prior));
        if (j >= 0 && daysBetween(s[j].d, iso(prior)) <= 20 && s[j].v) out.push({ d: p.d, v: (p.v / s[j].v - 1) * 100 });
      }
      return out;
    }
    case 'ma': return s.slice(n - 1).map((p, i) => ({ d: p.d, v: mean(s.slice(i, i + n).map(x => x.v)) }));
    default: throw new Error(`unknown transform ${t.kind}`);
  }
}

// Combine two series on common dates (used for spreads such as 2y yield minus Fed upper bound).
export function combine(a, b, fn) {
  const mb = new Map(clean(b).map(p => [p.d, p.v]));
  let lastB;
  const out = [];
  for (const p of clean(a)) {
    if (mb.has(p.d)) lastB = mb.get(p.d);
    if (lastB !== undefined) out.push({ d: p.d, v: fn(p.v, lastB) });
  }
  return out;
}

export const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
export function std(xs) {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, xs.length - 1));
}
export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

// Standard normal CDF (Abramowitz-Stegun 7.1.26). Maps a z-score to a 0..1 "percentile".
export function normCdf(z) {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2);
  return 0.5 * (1 + Math.sign(z) * y);
}

// Index of the last point dated on or before `d` (binary search). -1 if none.
export function asOfIndex(series, d) {
  let lo = 0, hi = series.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid].d <= d) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

// z-score of the point at index i against the trailing window that ends at i.
export function zAt(series, i, window) {
  const start = Math.max(0, i - window + 1);
  const xs = series.slice(start, i + 1).map(p => p.v);
  if (xs.length < Math.min(30, window)) return null;
  const sd = std(xs);
  return sd > 0 ? (series[i].v - mean(xs)) / sd : 0;
}

// Percentile rank (0..1) of the point at index i within the trailing window ending at i.
export function rankAt(series, i, window) {
  const start = Math.max(0, i - window + 1);
  const n = i - start + 1;
  if (n < Math.min(30, window)) return null;
  const x = series[i].v;
  let below = 0, equal = 0;
  for (let k = start; k <= i; k++) { if (series[k].v < x) below++; else if (series[k].v === x) equal++; }
  return (below + 0.5 * equal) / n;
}

export function sma(series, n, i = series.length - 1) {
  if (i + 1 < n) return null;
  return mean(series.slice(i - n + 1, i + 1).map(p => p.v));
}

export const round = (x, k = 2) => (x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x * 10 ** k) / 10 ** k);
