# Gold safe-haven meter

One 0–100 gauge that answers: **is the world pushing money into gold right now, or is the Fed pulling it out?**

It follows the chain a war shock actually travels:

```
War escalates ─► fear bid (GPR, VIX, gold vol) ─────────────────────────► gold UP, fast, often fades
      └────────► oil spikes ─► inflation rises ─► Fed turns hawkish ─► real yields & USD up ─► gold DOWN
```

Both paths run at once. The meter nets them, so you can see when fear wins and when the rate headwind wins.
In March 2026 the Iran strikes sent fear to ~99 within ten days, but by month-end the headwind was at ~94 and
gold had fallen 13.6%, its worst month since 2013.

**Dashboard:** <https://goldprabuda.github.io/safe-haven-meter/> ·
**Bot signal:** [`docs/data/signal.json`](docs/data/signal.json)

Runs free: **GitHub Actions** fetches and scores every 30 minutes, **GitHub Pages** hosts the dashboard,
**Telegram / ntfy** deliver alerts. No server, no database, no paid data.

## What it measures

| Gauge (share of meter) | Inputs | Effect on gold |
|---|---|---|
| **Fear bid** (40%) | War threats & war acts (Caldara-Iacoviello GPR, daily), Brent 10-day change, oil vol (OVX), VIX, gold vol (GVZ) | Lifts |
| **Rate & dollar headwind** (30%, inverted) | 2y yield minus Fed ceiling (hikes or cuts priced), 2y 20-day change, 10y real yield (TIPS) 20-day change, broad dollar 20-day change | Weighs |
| **Inflation impulse** (15%) | 10y breakeven 20-day change, CPI y/y, core CPI y/y | Lifts |
| **Flows & positioning** (15%) | CFTC managed-money net long (% of OI), GLD ETF holdings 20-day change | Lifts |
| **Liquidity gate** | Junk-bond credit spread. Above its 90th percentile the fear bid counts half (dash-for-cash risk, as in March 2020) | Gate |
| **Fed-cycle gate** | 2y yield vs Fed ceiling, and 2y 60-day change. See below | Gate |

### Fed-cycle gate

BIS research (Oct 2026) finds war risk barely moves gold while the Fed is tightening, because an oil-driven war
then means more hikes, higher real yields and a firmer dollar. So the meter reads the Fed regime from market pricing:

| Regime | Switches on when | While on |
|---|---|---|
| **Tightening** | 2y yield > Fed ceiling + 0.25 pp, **or** 2y up > 0.25 pp in 60 sessions (off below 0.15 on both) | Fear counts **half** (a quarter if credit is also stressed). Inflation **flips**: hot inflation means more hikes, so it weighs on gold |
| **Easing** | 2y yield < Fed ceiling − 0.25 pp and the 2y not rising | Everything counts normally |
| **On hold** | Otherwise | Everything counts normally |

Back-filled, it switched to tightening on 19 Mar 2026 as markets repriced from cuts to hikes, eased for three
days after the Hormuz reopening (20–22 Apr), and has been on since 23 Apr. A regime change sends an alert.

Each input is ranked against its own trailing history (percentile rank: 50 = normal, 90 = hotter than 90% of
the window). Gold's own price is never an input, so the meter can't just echo the price.

The **trade read** combines the meter with gold's trend (COMEX futures vs 50/200-day averages):

| Meter | Gold trend | Read |
|---|---|---|
| ≥ 60 | up | Tailwind aligned: buy dips toward the 50-day |
| ≥ 60 | down | Divergence: fear high, gold not responding. Wait |
| ≤ 40 | down | Headwind aligned: avoid fresh longs |
| ≤ 40 | up | Momentum only, tighten stops |
| fear ≥ 65 **and** headwind ≥ 65 | any | Tug-of-war: two-way swings, size down |
| fear ≥ 65 while the Fed is tightening | any | War vs Fed: don't buy the headline, wait for price |
| credit spread rank ≥ 90 | any | Credit stress: dash-for-cash risk |

The **silver tilt** watches the gold/silver ratio: rising with high fear = panic favours gold; falling = silver
(industrial/reflation) is outperforming with higher beta.

## Set up (about 10 minutes)

The repo is public, so Actions minutes are unlimited.

1. **Settings → Pages**: Source = *Deploy from a branch*, Branch = `main`, folder = `/docs` → Save.
2. **Settings → Secrets and variables → Actions → New repository secret.** All are optional and use the same
   names (and values) as the `gold-trading-intelligence` pipeline:
   - `FRED_API_KEY`: free at <https://fred.stlouisfed.org/docs/api/api_key.html>. Without it the keyless CSV
     download is used, which throttles bursts; the run then falls back to the last cached copy.
   - `TELEGRAM_TOKEN` and `TELEGRAM_CHAT_ID`: create a bot with @BotFather, message it once, then read
     your chat id from `https://api.telegram.org/bot<token>/getUpdates`.
   - `NTFY_TOPIC`: any hard-to-guess topic name, then subscribe to it in the ntfy app.
3. **Variables tab** (optional): `DASHBOARD_URL` = `https://goldprabuda.github.io/safe-haven-meter/`, added to every alert.
4. **Actions → Safe-haven meter → Run workflow** once. The first run records state and sends no alerts;
   alerts start from the second run.

Outputs are committed only when a reading changes, or every 2 hours as a heartbeat (`METER_HEARTBEAT_MIN`),
so the repo doesn't grow by a commit every 30 minutes.

Run locally: `npm ci && node src/run.mjs --no-alerts`, then serve `docs/` (`npx serve docs`). Tests: `npm test`.

## Alerts

| Alert | Fires when |
|---|---|
| Zone change | Meter crosses into Risk-on / Calm / Watchful / Elevated / Safe-haven ON (3-point buffer stops flip-flopping) |
| War threats / acts spiking | GPR 7-day average ≥ 2 standard deviations above normal |
| Oil shock | Brent +8% in 5 sessions |
| Panic | VIX ≥ 30 |
| Hawkish repricing | 2y yield +25 bp in 10 sessions |
| Real yields | 10y TIPS +20 bp in 10 sessions |
| Dollar | Broad dollar +2% in 10 sessions |
| Fed regime change | Tightening ↔ on hold ↔ easing |
| Tug-of-war / Divergence / Credit stress | From the trade read |

Each alert repeats at most once every 72 hours. Thresholds and weights live in `config/factors.mjs`.

## Data sources and licences

| Source | Used for | Notes |
|---|---|---|
| FRED, St. Louis Fed | Yields, TIPS, breakevens, Fed target, CPI, Brent, WTI, VIX, GVZ, OVX, dollar, USD/INR, HY spread | Daily series lag ~1 day; Brent ~2 days; dollar and USD/INR weekly. Not endorsed by the St. Louis Fed. |
| Caldara & Iacoviello GPR (matteoiacoviello.com) | War threats / acts, daily | CC BY. Updated weekly (Mondays). |
| CFTC Commitments of Traders | Managed-money positioning | Tuesday data, released Friday. |
| SPDR Gold Shares | GLD tonnes | Redistribution prohibited: only the derived rank is published. |
| ICE BofA HY spread (via FRED) | Liquidity gate | Licensed for internal use, 3 years of history: only the rank is published. |
| gold-api.com | Live XAU / XAG spot | Keyless. Display only. |
| COMEX futures closes (Yahoo chart API, unofficial) | Gold & silver trend, ratio | Kept in `data/prices.json` so a missed fetch never loses history. Spot and futures are never mixed. |

Every source falls back to the last good copy in `data/cache/` if it fails, and stale inputs count at half
weight. The dashboard shows coverage under the dial.

## Use it from your bots

`docs/data/signal.json` is a small, flat file made for trading bots. It is also served at
`https://raw.githubusercontent.com/goldprabuda/safe-haven-meter/main/docs/data/signal.json`, which works
even before Pages is switched on:

```json
{ "meter": 49.9, "zone": "watch", "bias": "neutral", "regime": "tightening", "flags": "fed_tightening",
  "allowLong": 1, "allowShort": 1, "lotFactor": 1, "pyramid": 1, "generatedUnix": 1793335985, ... }
```

| Integration | File | What it does |
|---|---|---|
| **DollarDesk EA (MT5)** | [`integrations/mt5/`](integrations/mt5/) | Drop-in `SafeHavenFilter.mqh`: blocks longs/shorts/pyramid adds and scales lots per the meter |
| **gold-trading-intelligence** | [`integrations/pipeline/`](integrations/pipeline/) | Patch that gives Claude the regime and adds a meter line to alerts |
| **Any Python bot** (e.g. gold-scalp-bot) | [`integrations/python/safe_haven.py`](integrations/python/safe_haven.py) | `get_meter()` + `meter_context()` for LLM prompts |

What each trade read allows is set in `config/factors.mjs → EA_POLICY` (caution = half size, no pyramiding).

## Layout

```
config/factors.mjs   weights, windows, gates, bot policy, alert rules (edit here)
src/sources.mjs      free data fetchers (FRED queue + circuit breaker, GPR, COT, GLD, spot, futures)
src/engine.mjs       ranking, gauges, liquidity + Fed-cycle gates, trend, trade read, silver tilt, back-fill
src/alerts.mjs       alert rules, cooldowns, Telegram + ntfy delivery
src/run.mjs          entry point; writes docs/data/latest.json, history.json and signal.json
integrations/        MT5 include, pipeline patch, Python helper
docs/index.html      the dashboard (static, no build step)
.github/workflows/   the 30-minute schedule
```

## Limits

- Daily macro data makes this a **daily-to-weekly regime gauge**, not an intraday signal. Use it to choose
  direction and size; time entries on price.
- Research finds geopolitical risk explains only a small share of gold's moves, and event spikes usually fade
  within 2–4 weeks. The meter is a context tool, not a forecast.
- Weights are fixed expert weights, not fitted to past returns (fitted weights overfit as the gold/real-yield
  link keeps breaking). Back-test before trusting changes.
- Educational tool, not investment advice.
