// Alert rules + delivery (Telegram and/or ntfy.sh). State lives in data/state.json so
// the same alert doesn't fire every run (cooldown) and zone flips need to clear a buffer.
import { ALERTS } from '../config/factors.mjs';
import { zoneOf, REGIME_TEXT } from './engine.mjs';
import { transform } from './lib.mjs';

const last = s => (s?.length ? s[s.length - 1].v : null);

export function evaluate({ live, data, display, read, prevState }) {
  const A = ALERTS;
  const hits = [];
  const add = (key, title, body, level = 'info') => hits.push({ key, title, body, level });

  // 1) Meter zone change (with hysteresis)
  const zone = zoneOf(live.meter, prevState.zone, A.zoneHysteresis);
  if (prevState.zone && zone.key !== prevState.zone) {
    add(`zone:${zone.key}`, `Meter now ${zone.label} (${live.meter.toFixed(0)})`,
      `Safe-haven meter moved from ${prevState.zoneLabel ?? prevState.zone} to ${zone.label}. ${read.text}`,
      zone.key === 'haven' ? 'high' : 'info');
  }

  // 1b) Fed regime change (tightening / easing / on hold)
  if (prevState.fedRegime && live.regime !== prevState.fedRegime) {
    const R = REGIME_TEXT[live.regime];
    add(`regime:${live.regime}`, `Fed regime now: ${R.label}`, R.text, live.regime === 'tightening' ? 'high' : 'info');
  }

  // 2) War escalation
  for (const [id, what] of [['gpr_threat', 'threats'], ['gpr_acts', 'acts']]) {
    const w = live.factors[id];
    if (w?.z >= A.warZ) add(`war_${what}`, `War ${what} spiking`,
      `Geopolitical risk index (war ${what}) is ${w.z.toFixed(1)} standard deviations above normal (7-day avg ${w.value.toFixed(0)}).`, 'high');
  }
  if (read.flags.includes('liquidity_stress')) add('liquidity', 'Credit stress: dash-for-cash risk', read.text, 'high');

  // 3) Oil shock
  const brent = display.brent;
  if (Array.isArray(brent)) {
    const p5 = last(transform(brent, { kind: 'pct', n: 5 }));
    if (p5 !== null && p5 >= A.oilJumpPct) add('oil', `Brent +${p5.toFixed(1)}% in 5 sessions`,
      `Brent at $${last(brent).toFixed(2)}. Oil shocks feed inflation fears first, then Fed hawkishness.`, 'high');
  }

  // 4) Panic
  const vix = live.factors.vix;
  if (vix?.value >= A.vixLevel) add('vix', `VIX at ${vix.value.toFixed(1)}`, 'Equity panic. Note: in a liquidity crunch gold can fall first as traders raise cash.', 'high');

  // 5) Hawkish repricing, real yields, dollar
  const y2 = display.y2;
  if (Array.isArray(y2)) {
    const c = last(transform(y2, { kind: 'chg', n: 10 }));
    if (c !== null && c * 100 >= A.hawkish2yBp) add('hawkish', `2y yield +${(c * 100).toFixed(0)}bp in 10 sessions`,
      'Markets are pricing a more hawkish Fed. Headwind for gold even if war risk is high.');
  }
  const ry = display.real10;
  if (Array.isArray(ry)) {
    const c = last(transform(ry, { kind: 'chg', n: 10 }));
    if (c !== null && c * 100 >= A.realYieldBp) add('realyield', `Real yield +${(c * 100).toFixed(0)}bp in 10 sessions`,
      `10y TIPS yield ${last(ry).toFixed(2)}%. Rising real yields raise the cost of holding gold.`);
  }
  const usd = data.dollar?.raw;
  if (usd?.length) {
    const c = last(transform(usd, { kind: 'pct', n: 10 }));
    if (c !== null && c >= A.dollarJumpPct) add('usd', `Dollar +${c.toFixed(1)}% in 10 sessions`, 'A strong dollar makes gold dearer for non-US buyers.');
  }

  // 6) Structural flags from the trade read
  if (read.flags.includes('tug_of_war')) add('tug', 'Tug-of-war: fear vs Fed', read.text, 'high');
  if (read.flags.includes('divergence')) add('divergence', 'Divergence: fear high, gold weak', read.text);

  return { zone, hits };
}

export function applyCooldown(hits, prevState, now = Date.now()) {
  const sent = { ...(prevState.sent ?? {}) };
  const due = hits.filter(h => {
    const t = sent[h.key];
    if (t && now - new Date(t).getTime() < ALERTS.cooldownHours * 36e5) return false;
    sent[h.key] = new Date(now).toISOString();
    return true;
  });
  return { due, sent };
}

// ntfy rejects non-ASCII in HTTP headers (Title/Tags), so titles are stripped to ASCII.
const ascii = s => s.replace(/[^\x20-\x7E]/g, '').trim();

export async function deliver(alerts, { meter, zone, dashboardUrl }) {
  const results = [];
  const footer = `\nMeter ${meter.toFixed(0)}/100 (${zone.label})${dashboardUrl ? `\n${dashboardUrl}` : ''}`;
  // Same secret names as the gold-trading-intelligence pipeline (TELEGRAM_TOKEN), old name still accepted.
  const { TELEGRAM_CHAT_ID, NTFY_TOPIC, NTFY_SERVER = 'https://ntfy.sh' } = process.env;
  const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
  for (const a of alerts) {
    if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
      const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: `${a.title}\n${a.body}${footer}`, disable_web_page_preview: true }),
      }).catch(e => ({ ok: false, statusText: e.message }));
      results.push({ via: 'telegram', key: a.key, ok: res.ok });
    }
    if (NTFY_TOPIC) {
      const res = await fetch(`${NTFY_SERVER}/${NTFY_TOPIC}`, {
        method: 'POST', body: `${a.body}${footer}`,
        headers: { Title: ascii(`Gold meter: ${a.title}`), Priority: a.level === 'high' ? '4' : '3', Tags: a.level === 'high' ? 'warning' : 'chart_with_upwards_trend' },
      }).catch(e => ({ ok: false, statusText: e.message }));
      results.push({ via: 'ntfy', key: a.key, ok: res.ok });
    }
  }
  return results;
}
