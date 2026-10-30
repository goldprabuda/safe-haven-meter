# gold-trading-intelligence + safe-haven meter

`gold-analysis.v4.patch` adds the meter to the pipeline that runs hourly from
`.github/workflows/gold-intel.yml` (the workflow runs **`gold-analysis.v4.js`**, so that's the file patched).

## What changes

1. **Fetches `signal.json`** in parallel with FRED, calendar and news. It needs no key, and is ignored if more than 8 hours old.
2. **Gives Claude the regime.** A new *SAFE-HAVEN METER* section goes into the prompt, and two of the
   hard-coded rules become regime-aware:
   - "Geopolitical shock => Gold up" now adds: if the Fed is tightening, the bid fades fast
     (war → oil → inflation → more hikes → gold down, as in March 2026).
   - "Hot CPI => metals mixed" now adds: bearish for metals while the Fed is tightening.
3. **Adds one line to the ntfy and Telegram alerts**, e.g.
   `Safe-haven meter 50/100 watch | Fed tightening | bias neutral`. Underscores and asterisks are stripped,
   so Telegram's Markdown mode can't break.

There are no new secrets, and nothing changes if the meter is down: the prompt just says "Unavailable".

## Apply it (2 minutes)

```bash
cd gold-trading-intelligence
git checkout -b safe-haven-meter
git apply ../safe-haven-meter/integrations/pipeline/gold-analysis.v4.patch
node --check gold-analysis.v4.js
git commit -am "Add safe-haven meter regime context"
git push -u origin safe-haven-meter     # then open a PR and merge when happy
```

Or ask Claude to push the branch for you; it needs push access to that repo.

## Two things noticed while checking the pipeline

- `.github/workflows/gold-intel` (no `.yml`) looks like a stray copy of the workflow. GitHub ignores it,
  so it's safe to delete.
- The hourly cron runs at minute 0 (`'0 5-21 * * 1-5'`), when GitHub's scheduler is busiest and runs
  are often delayed or skipped. `'7 5-21 * * 1-5'` is more reliable.
