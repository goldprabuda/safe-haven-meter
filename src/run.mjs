// Entry point. Runs on a GitHub Actions schedule (or locally: `node src/run.mjs --no-alerts`).
// Fetches every factor, scores them, writes docs/data/*.json for the dashboard and sends alerts.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { GAUGES, FACTORS, DISPLAY, ALERTS } from '../config/factors.mjs';
import { loadFactors, loadDisplay, scoreAt, zoneOf, trend, tradeRead, silverTilt, backfill } from './engine.mjs';
import { evaluate, applyCooldown, deliver } from './alerts.mjs';
import { spot, yahoo, gprEvents } from './sources.mjs';
import { clean, iso, round } from './lib.mjs';

const args = new Set(process.argv.slice(2));
const NO_ALERTS = args.has('--no-alerts');
const today = iso(Date.now());
const readJson = async (p, dflt) => { try { return JSON.parse(await readFile(p, 'utf8')); } catch { return dflt; } };
const last = s => (Array.isArray(s) && s.length ? s[s.length - 1] : null);
const log = (...a) => console.log('[meter]', ...a);

await mkdir('docs/data', { recursive: true });
await mkdir('data', { recursive: true });
const state = await readJson('data/state.json', {});
const prices = await readJson('data/prices.json', {});

// ---- 1. Prices ----
// Trend and gold/silver ratio use one consistent series (COMEX futures daily closes),
// kept in data/prices.json so a missed fetch never loses history. The live spot price
// (gold-api.com, keyless) is display-only: spot and futures differ by ~$10-20 and
// must not be mixed in one series.
const spotNow = {};
for (const [sym, yh] of [['XAU', 'GC=F'], ['XAG', 'SI=F']]) {
  const key = `${sym}_F`;
  try {
    const hist = await yahoo(yh, (prices[key]?.length ?? 0) < 200 ? '2y' : '1mo');
    prices[key] = clean([...(prices[key] ?? []), ...hist]).slice(-800);
  } catch (e) { log(`futures history ${yh} not refreshed: ${e.message}`); }
  try { spotNow[sym] = await spot(sym); } catch (e) { log(`spot ${sym} failed: ${e.message}`); }
}
delete prices.XAU; delete prices.XAG;

// ---- 2. Factors and display series ----
const data = await loadFactors();
const display = await loadDisplay(DISPLAY);
for (const f of FACTORS) if (data[f.id].error) log(`factor ${f.id} unavailable: ${data[f.id].error}`);

const live = scoreAt(data, today, { live: true });
if (live.meter === null) { console.error('No factor data at all; aborting without overwriting outputs.'); process.exit(1); }

const goldTrend = trend(prices.XAU_F);
const silverTrend = trend(prices.XAG_F);
const read = tradeRead(live.meter, live.gauges, goldTrend, ALERTS.tugOfWar, live.gate);
const tilt = silverTilt(prices.XAU_F, prices.XAG_F, live.meter);
const history = backfill(data, 400, prices.XAU_F ?? []);

// ---- 3. Alerts ----
const { zone, hits } = evaluate({ live, data, display, read, prevState: state });
let sentLog = state.log ?? [];
let sent = state.sent ?? {};
if (!state.zone) {
  log('first run: recording state, no alerts sent');
} else {
  const cd = applyCooldown(hits, state);
  sent = cd.sent;
  if (cd.due.length) {
    const res = NO_ALERTS ? [] : await deliver(cd.due, { meter: live.meter, zone, dashboardUrl: process.env.DASHBOARD_URL });
    log(`alerts: ${cd.due.map(a => a.key).join(', ')}${NO_ALERTS ? ' (not sent: --no-alerts)' : ''}`, res);
    sentLog = [...cd.due.map(a => ({ at: new Date().toISOString(), ...a })), ...sentLog].slice(0, 50);
  }
}

// ---- 4. Outputs ----
const lv = k => (Array.isArray(display[k]) ? last(display[k]) : null);
const usdinr = lv('usdinr');
const gold = spotNow.XAU, silver = spotNow.XAG;
const factorOut = FACTORS.map(f => {
  const r = live.factors[f.id];
  return {
    id: f.id, label: f.label, gauge: f.gauge, chain: f.chain ?? null, unit: f.unit,
    asOf: r.asOf ?? null, z: round(r.z, 2), score: round(r.score, 1),
    stale: !!r.stale, error: r.error ?? null, weight: f.weight,
    ...(f.publishRaw === false
      ? { value: null, spark: null, restricted: true }
      : { value: round(r.value, 3), spark: (data[f.id].tx ?? []).slice(-120).map(p => round(p.v, 3)) }),
  };
});

let events = [];
try { events = (await gprEvents(500)).slice(-12).reverse(); } catch { /* optional */ }

const latest = {
  generatedAt: new Date().toISOString(),
  meter: round(live.meter, 1),
  coverage: round(live.coverage, 2),
  zone: { key: zone.key, label: zone.label },
  gauges: Object.fromEntries(Object.entries(GAUGES).map(([k, G]) => [k, {
    label: G.label, blurb: G.blurb, effect: G.effect, weight: G.weight,
    score: round(live.gauges[k].score, 1), coverage: round(live.gauges[k].coverage, 2),
    ...(live.gauges[k].raw !== undefined ? { beforeGate: round(live.gauges[k].raw, 1) } : {}),
  }])),
  gate: { label: 'Credit stress (junk-bond spread rank)', score: round(live.gate.score, 1), stressed: live.gate.stressed, threshold: ALERTS.liquidityGate },
  factors: factorOut,
  read, silver: tilt,
  market: {
    gold: gold && { price: gold.price, at: gold.at, trend: goldTrend },
    silver: silver && { price: silver.price, at: silver.at, trend: silverTrend },
    goldInr10g: gold && usdinr ? round(gold.price * usdinr.v / 31.1035 * 10, 0) : null,
    ...Object.fromEntries(Object.keys(DISPLAY).filter(k => k !== 'cotSilver').map(k => [k, lv(k) && { value: lv(k).v, asOf: lv(k).d, label: DISPLAY[k].label }])),
    cotSilver: lv('cotSilver') && { value: round(lv('cotSilver').v, 1), asOf: lv('cotSilver').d },
  },
  goldSpark: (prices.XAU_F ?? []).slice(-120).map(p => p.v),
  events,
  alerts: sentLog.slice(0, 15),
  pending: hits.map(h => h.key),
};

await writeFile('docs/data/latest.json', JSON.stringify(latest, null, 1));
await writeFile('docs/data/history.json', JSON.stringify(history));
await writeFile('data/prices.json', JSON.stringify(prices));
await writeFile('data/state.json', JSON.stringify({ zone: zone.key, zoneLabel: zone.label, sent, log: sentLog, updatedAt: latest.generatedAt }, null, 1));

log(`meter ${latest.meter} (${zone.label}) | fear ${latest.gauges.fear.score} infl ${latest.gauges.inflation.score} headwind ${latest.gauges.headwind.score} flows ${latest.gauges.flows.score} | ${read.bias}`);
