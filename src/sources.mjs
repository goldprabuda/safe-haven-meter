// Free data sources. Every fetcher returns a clean ascending series [{d, v}].
// None of these need a paid plan. FRED works keyless via the public CSV download;
// set FRED_API_KEY (free) to use the official JSON API instead.
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { http, clean, iso, addDays } from './lib.mjs';

const require = createRequire(import.meta.url);

// ---------- FRED (St. Louis Fed) ----------
// FRED's public CSV download throttles bursts, so requests run one at a time, spaced out
// and each series is fetched once per run.
const fredCache = new Map();
let fredActive = 0;
let fredFailures = 0;   // circuit breaker: after 3 straight failures, stop asking FRED this run
const fredWaiters = [];
async function fredSlot(fn) {
  if (fredActive >= 1) await new Promise(r => fredWaiters.push(r));
  fredActive++;
  try { return await fn(); }
  finally {
    await new Promise(r => setTimeout(r, process.env.FRED_API_KEY ? 300 : 1200));
    fredActive--;
    fredWaiters.shift()?.();
  }
}
export function fred(id, opts) {
  if (!fredCache.has(id)) fredCache.set(id, fredSlot(() => fredFetch(id, opts)).then(
    async series => { await saveCache(`fred-${id}`, series); return series; },
    async err => {
      // FRED down or rate-limiting: fall back to the last good copy kept in the repo.
      const cached = await loadCache(`fred-${id}`);
      if (cached?.length) { console.log(`[meter] FRED ${id} failed (${err.message}); using cached copy to ${cached[cached.length - 1].d}`); return cached; }
      throw err;
    }));
  return fredCache.get(id);
}

// Last-good-data cache (data/cache/*.json), committed by the workflow so a flaky
// source never blanks the dashboard. Staleness is still judged by each point's date.
const CACHE_DIR = process.env.METER_CACHE_DIR ?? 'data/cache';
// Licensed series (ICE credit spread, GLD holdings) must not be committed to a public
// repo, so their cache goes to a git-ignored folder and only helps local runs.
const RESTRICTED = new Set(['fred-BAMLH0A0HYM2', 'gld']);
const cachePath = name => `${CACHE_DIR}/${RESTRICTED.has(name) ? 'private/' : ''}${name}.json`;
async function saveCache(name, series) {
  try { await mkdir(cachePath(name).replace(/\/[^/]+$/, ''), { recursive: true }); await writeFile(cachePath(name), JSON.stringify(series)); } catch { /* best effort */ }
}
async function loadCache(name) {
  try { return JSON.parse(await readFile(cachePath(name), 'utf8')); } catch { return null; }
}
export const withCache = (name, fn) => fn().then(
  async s => { await saveCache(name, s); return s; },
  async err => { const c = await loadCache(name); if (c?.length) { console.log(`[meter] ${name} failed (${err.message}); using cached copy`); return c; } throw err; });
async function fredFetch(id, opts) {
  if (process.env.METER_OFFLINE) throw new Error('offline mode');
  if (fredFailures >= 3) throw new Error('FRED unavailable this run (circuit open)');
  try { const s = await fredFetchOnce(id, opts); fredFailures = 0; return s; }
  catch (e) { fredFailures++; throw e; }
}
async function fredFetchOnce(id, { start = addDays(iso(Date.now()), -365 * 6) } = {}) {
  const key = process.env.FRED_API_KEY;
  if (key) {
    const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${id}&api_key=${key}&file_type=json&observation_start=${start}`;
    const j = await http(url, { as: 'json', retries: 3, backoffMs: 3000 });
    return clean(j.observations.map(o => ({ d: o.date, v: o.value === '.' || o.value === '' ? NaN : Number(o.value) })));
  }
  const csv = await http(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}&cosd=${start}`, { retries: 3, backoffMs: 3000 });
  return clean(csv.trim().split('\n').slice(1).map(line => {
    const [d, v] = line.split(',');
    // FRED marks holidays with '.' or leaves the value blank; Number('') is 0, so both must become NaN
    const t = (v ?? '').trim();
    return { d, v: t === '' || t === '.' ? NaN : Number(t) };
  }));
}

// ---------- Geopolitical Risk index (Caldara & Iacoviello), daily ----------
// One download gives three series: overall GPR, "acts" (war actually happening)
// and "threats" (war talk). Updated roughly weekly by the authors.
let gprCache;
export async function gpr(column = 'GPRD') {
  if (!gprCache) {
    const XLSX = require('xlsx');
    const buf = await http('https://www.matteoiacoviello.com/gpr_files/data_gpr_daily_recent.xls', { as: 'buffer', timeoutMs: 60000 });
    const wb = XLSX.read(buf);
    const ws = wb.Sheets[wb.SheetNames[0]];
    gprCache = XLSX.utils.sheet_to_json(ws, { raw: true });
  }
  return clean(gprCache.map(r => {
    const s = String(r.DAY);
    return { d: `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`, v: Number(r[column]) };
  }));
}

// Recent dated events the GPR authors annotate in the same file (e.g. "Russia invades Ukraine").
export async function gprEvents(sinceDays = 400) {
  await gpr();
  const cutoff = addDays(iso(Date.now()), -sinceDays);
  return gprCache
    .filter(r => r.event)
    .map(r => { const s = String(r.DAY); return { d: `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`, event: String(r.event) }; })
    .filter(e => e.d >= cutoff);
}

// ---------- CFTC Commitments of Traders (disaggregated, futures only) ----------
// Managed-money net long as % of open interest. Gold 088691, silver 084691. Weekly (Tue data, Fri release).
export async function cotManagedMoney(code = '088691') {
  const url = `https://publicreporting.cftc.gov/resource/72hh-3qpy.json?cftc_contract_market_code=${code}` +
    `&$select=report_date_as_yyyy_mm_dd,m_money_positions_long_all,m_money_positions_short_all,open_interest_all` +
    `&$order=report_date_as_yyyy_mm_dd%20DESC&$limit=400`;
  const rows = await http(url, { as: 'json' });
  return clean(rows.map(r => ({
    d: r.report_date_as_yyyy_mm_dd.slice(0, 10),
    v: ((Number(r.m_money_positions_long_all) - Number(r.m_money_positions_short_all)) / Number(r.open_interest_all)) * 100,
  })));
}

// ---------- SPDR Gold Shares (GLD) holdings, tonnes ----------
// The issuer's terms forbid redistributing this file, so the dashboard publishes only
// the derived score (a rank), never the tonnage itself.
const MONTHS = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
export async function gldHoldings() {
  const XLSX = require('xlsx');
  const buf = await http('https://api.spdrgoldshares.com/api/v1/historical-archive?product=gld&exchange=NYSE&lang=en', { as: 'buffer', timeoutMs: 60000 });
  const wb = XLSX.read(buf);
  const name = wb.SheetNames.find(n => /archive/i.test(n)) ?? wb.SheetNames[1];
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true });
  const col = rows[0].findIndex(h => /tonnes/i.test(String(h)));
  return clean(rows.slice(1).map(r => {
    const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(String(r[0] ?? '').trim());
    return m ? { d: `${m[3]}-${MONTHS[m[2]]}-${m[1].padStart(2, '0')}`, v: Number(r[col]) } : null;
  }).filter(Boolean)).slice(-1500);
}

// ---------- Live spot prices (keyless) ----------
export async function spot(symbol) {
  const j = await http(`https://api.gold-api.com/price/${symbol}`, { as: 'json' });
  return { price: Number(j.price), at: j.updatedAt };
}

// ---------- Yahoo Finance daily history (unofficial, may rate-limit) ----------
// Used only to bootstrap price history once; the repo then keeps its own history.
export async function yahoo(symbol, range = '2y') {
  const j = await http(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d`, { as: 'json', retries: 1 });
  const r = j.chart.result[0];
  return clean(r.timestamp.map((t, i) => ({ d: iso(t * 1000), v: r.indicators.quote[0].close[i] })));
}
