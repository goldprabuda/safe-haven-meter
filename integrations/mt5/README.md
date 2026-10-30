# DollarDesk (MT5) + safe-haven meter

`SafeHavenFilter.mqh` lets any MT5 gold EA ask the meter three questions before it trades:
may I open a long or a short, may I add a pyramid layer, and how big should the lot be.
It never opens, modifies or closes a trade on its own.

## What the EA receives

The meter publishes `docs/data/signal.json` every run (every 30 minutes on weekdays, committed
when something changes or at least every 2 hours). The policy per trade read lives in
`config/factors.mjs → EA_POLICY`:

| Meter read | New longs | New shorts | Pyramid adds | Lot size |
|---|---|---|---|---|
| bullish (meter ≥ 60, gold trending up) | yes | **no** | yes | 100% |
| bearish (meter ≤ 40, gold trending down) | **no** | yes | yes | 100% |
| caution (tug-of-war, war vs Fed, divergence, credit stress) | yes | yes | **no** | **50%** |
| neutral | yes | yes | yes | 100% |

If the file can't be fetched or is older than 8 hours, the filter steps aside and the EA trades
normally (set `InpSHM_FailClosed = true` to block new trades instead).

## Setup (10 minutes)

**1. Copy the file.** In MetaEditor: File → Open Data Folder → `MQL5\Include\` → paste
`SafeHavenFilter.mqh`.

**2. Allow the URL.** MT5: Tools → Options → Expert Advisors → tick
*Allow WebRequest for listed URL* → add `https://raw.githubusercontent.com` → OK.

**3. Five edits in `DollarDesk_XAUUSD_EA_Pyramid.mq5`.**

```mql5
// (a) top of the file, with the other #include lines
#include <SafeHavenFilter.mqh>

// (b) in OnInit(), before return(INIT_SUCCEEDED)
   EventSetTimer(60);          // skip if DollarDesk already sets a timer
   SHM_Update(true);
   Print(SHM_Status());

// (c) in OnTimer()  (create it if DollarDesk has none)
void OnTimer()
  {
   SHM_Update();               // downloads at most every 15 min
   Comment(SHM_Status());      // optional: shows the meter on the chart
  }
// and in OnDeinit(): EventKillTimer();  (only if you added the timer in (b))

// (d) right before each NEW position is opened
   if(isBuy  && !SHM_AllowLong())  { Print("Meter blocks new long: ",  SHM_Status()); return; }
   if(!isBuy && !SHM_AllowShort()) { Print("Meter blocks new short: ", SHM_Status()); return; }
   lots = SHM_AdjustLots(_Symbol, lots);

// (e) right before each PYRAMID add (a layer on an existing position)
   if(!SHM_AllowPyramid()) return;
   addLots = SHM_AdjustLots(_Symbol, addLots);
```

Use your EA's own names for `isBuy`, `lots` and `addLots`. Put the checks only on **new**
entries and adds, never on exits, stop-loss or trailing logic.

**4. Compile (F7)** and attach to the XAUUSD chart. The Experts tab should print something like:

```
Meter 50 watch | Fed tightening | bias neutral | long ok short ok pyramid ok | lots x1.00 | 23 min old
```

If it says `add https://raw.githubusercontent.com ...`, step 2 was missed.

## Notes

- **Backtests are unaffected:** WebRequest doesn't run in the Strategy Tester, so the filter
  switches itself off there. To test the filter's effect historically, use `docs/data/history.json`
  (daily meter back to 2025) instead.
- **This is a daily-to-weekly macro filter, not a timing signal.** Keep DollarDesk's own entries,
  stops and targets; the meter only says which side and what size are sensible.
- To change the policy (for example 0.25 lots in caution), edit `EA_POLICY` in `config/factors.mjs`.
  The EA picks it up on the next run with no recompile.
