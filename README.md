# Gold safe-haven meter

One 0–100 gauge that answers: **is the world pushing money into gold right now, or is the Fed pulling it out?**

It follows the chain a war shock actually travels:

```
War escalates ─► fear bid (GPR, VIX, gold vol) ─────────────────────────► gold UP, fast, often fades
      └────────► oil spikes ─► inflation rises ─► Fed turns hawkish ─► real yields & USD up ─► gold DOWN
```

Both paths run at once. The meter nets them, so you can see when fear wins and when the rate headwind wins
(in March 2026 the Iran strikes sent fear to ~90, but the headwind hit ~97 and gold fell 13.6% that month).

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

The **silver tilt** watches the gold/silver ratio: rising with high fear = panic favours gold; falling = silver
(industrial/reflation) is outperforming with higher beta.

## Set up (about 15 minutes)

1. **Create a public GitHub repo** and push this folder to it. Public repos get unlimited Actions minutes;
   a private repo on the free plan would use most of its monthly allowance at a 30-minute schedule.
2. **Settings → Pages**: Source = *Deploy from a branch*, Branch = `main`, folder = `/docs`.
3. **Settings → Secrets and variables → Actions → Secrets** (all optional):
   - `FRED_API_KEY`: free at <https://fred.stlouisfed.org/docs/api/api_key.html>. Without it the keyless CSV
     download is used, which throttles bursts; the run then falls back to the last cached copy.
   - `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`: create a bot with @BotFather, message it once, then read
     your chat id from `https://api.telegram.org/bot<token>/getUpdates`.
   - `NTFY_TOPIC`: any hard-to-guess topic name, then subscribe to it in the ntfy app.
4. **Variables** (optional): `DASHBOARD_URL` = your Pages URL, added to every alert.
5. **Actions → Safe-haven meter → Run workflow** once. The first run records state and sends no alerts;
   alerts start from the second run.

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

## Layout

```
config/factors.mjs   weights, windows, thresholds, alert rules (edit here)
src/sources.mjs      free data fetchers (FRED queue + circuit breaker, GPR, COT, GLD, spot, futures)
src/engine.mjs       ranking, gauges, liquidity gate, trend, trade read, silver tilt, history back-fill
src/alerts.mjs       alert rules, cooldowns, Telegram + ntfy delivery
src/run.mjs          entry point; writes docs/data/latest.json and history.json
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
