"""Read the Gold Safe-Haven Meter from any Python bot (gold-scalp-bot, notebooks, scripts).

    from safe_haven import get_meter, meter_context
    m = get_meter()                 # dict, or None if unavailable/stale
    prompt += meter_context(m)      # one paragraph for an LLM prompt

No dependencies beyond the standard library.
"""
from __future__ import annotations

import json
import time
import urllib.request

SIGNAL_URL = "https://raw.githubusercontent.com/goldprabuda/safe-haven-meter/main/docs/data/signal.json"
MAX_AGE_HOURS = 8
_cache: dict = {"at": 0.0, "data": None}


def get_meter(url: str = SIGNAL_URL, max_age_hours: float = MAX_AGE_HOURS, cache_seconds: int = 600) -> dict | None:
    """Return the latest signal as a dict, or None if it can't be fetched or is too old."""
    now = time.time()
    if _cache["data"] is not None and now - _cache["at"] < cache_seconds:
        data = _cache["data"]
    else:
        try:
            with urllib.request.urlopen(url, timeout=8) as r:
                data = json.loads(r.read().decode("utf-8"))
        except Exception:
            return None
        _cache.update(at=now, data=data)
    age_h = (now - float(data.get("generatedUnix", 0))) / 3600
    if age_h > max_age_hours:
        return None
    return {**data, "ageHours": round(age_h, 2)}


def meter_context(m: dict | None) -> str:
    """Plain-English macro context for an LLM prompt."""
    if not m:
        return "SAFE-HAVEN METER: unavailable. Judge macro context from your own data.\n"
    regime_rule = (
        "The Fed is TIGHTENING: war or oil headlines tend to push yields and the dollar up and gold DOWN "
        "after the first days; hot inflation data is bearish for gold."
        if m.get("regime") == "tightening" else
        "The Fed is not tightening: war fear and inflation can support gold normally."
    )
    return (
        f"SAFE-HAVEN METER (0-100, >60 haven demand dominates, <40 rate/dollar headwind dominates)\n"
        f"Meter {m['meter']} ({m['zone']}), trade read {m['bias'].upper()}, Fed regime {m['regime']}.\n"
        f"Gauges: fear {m['fear']}, rate & dollar headwind {m['headwind']}, inflation {m['inflation']}, flows {m['flows']}.\n"
        f"Gold trend {m['goldTrend']}, gold/silver ratio {m['silverRatio']}. {regime_rule}\n"
        f"Meter note: {m['note']}\n"
    )


if __name__ == "__main__":
    m = get_meter()
    print(meter_context(m))
    if m:
        print({k: m[k] for k in ("allowLong", "allowShort", "lotFactor", "pyramid")})
