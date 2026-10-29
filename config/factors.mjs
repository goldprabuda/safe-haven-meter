// What the meter measures. Edit weights here; nothing else needs to change.
//
// Each factor is ranked against its own trailing history (percentile rank, which copes
// with fat tails better than a z-score; the ECB's CISS stress index does the same).
// 50 = typical, 90 = hotter than 90% of the window. Factor scores roll up into four
// gauges; the gauges roll up into the meter. Gold's own price is deliberately NOT an
// input, so the meter can't just echo the price back.
//
//   dir        +1 if a higher reading means MORE of what the gauge measures
//   window     trailing observations used for the ranking
//   lagDays    days after the observation date that the value is actually published
//              (used only when back-filling history, so the past isn't scored with
//              data nobody had yet)
//   maxAgeDays older than this = stale, counted at half weight
//   publishRaw false = the source's licence restricts redistribution, so the public
//              dashboard shows only the derived score (rank), never the raw value

export const GAUGES = {
  fear:      { label: 'Fear bid',              weight: 0.40, effect: +1, blurb: 'War, panic and oil-shock demand for safety' },
  inflation: { label: 'Inflation impulse',     weight: 0.15, effect: +1, blurb: 'Rising inflation erodes cash and bonds; gold hedges it' },
  headwind:  { label: 'Rate & dollar headwind', weight: 0.30, effect: -1, blurb: 'Hawkish Fed, rising real yields and a firm dollar weigh on gold' },
  flows:     { label: 'Flows & positioning',   weight: 0.15, effect: +1, blurb: 'ETF buying and speculative futures positioning' },
};

const DAILY = { window: 504, lagDays: 1, maxAgeDays: 7 };

export const FACTORS = [
  // ---- Fear bid -------------------------------------------------------------
  { id: 'gpr_threat', gauge: 'fear', label: 'War threats (GPR, 7-day avg)', chain: 'war',
    source: { type: 'gpr', column: 'GPRD_THREAT' }, transform: { kind: 'ma', n: 7 },
    window: 730, lagDays: 5, maxAgeDays: 14, weight: 0.20, dir: +1, unit: 'index' },
  { id: 'gpr_acts', gauge: 'fear', label: 'War acts (GPR, 7-day avg)', chain: 'war',
    source: { type: 'gpr', column: 'GPRD_ACT' }, transform: { kind: 'ma', n: 7 },
    window: 730, lagDays: 5, maxAgeDays: 14, weight: 0.15, dir: +1, unit: 'index' },
  { id: 'oil_shock', gauge: 'fear', label: 'Brent crude, 10-day change', chain: 'oil',
    source: { type: 'fred', id: 'DCOILBRENTEU' }, transform: { kind: 'pct', n: 10 },
    ...DAILY, lagDays: 3, maxAgeDays: 10, weight: 0.20, dir: +1, unit: '%' },
  { id: 'ovx', gauge: 'fear', label: 'Oil volatility (OVX)', chain: 'oil',
    source: { type: 'fred', id: 'OVXCLS' }, transform: { kind: 'level' },
    ...DAILY, weight: 0.15, dir: +1, unit: '' },
  { id: 'vix', gauge: 'fear', label: 'Equity fear (VIX)',
    source: { type: 'fred', id: 'VIXCLS' }, transform: { kind: 'level' },
    ...DAILY, weight: 0.15, dir: +1, unit: '' },
  { id: 'gvz', gauge: 'fear', label: 'Gold volatility (GVZ)',
    source: { type: 'fred', id: 'GVZCLS' }, transform: { kind: 'level' },
    ...DAILY, weight: 0.15, dir: +1, unit: '' },

  // ---- Liquidity gate (not a gauge) -------------------------------------------
  // When credit markets seize up, investors sell everything, gold included, to raise
  // cash (March 2020: gold's worst week since 1983 while fear was extreme). BIS research
  // finds geopolitical shocks barely lift gold when financial conditions are tight.
  // So a stressed credit spread halves the fear bid's pull instead of adding to it.
  { id: 'hy', gauge: 'gate', label: 'Junk-bond credit spread',
    source: { type: 'fred', id: 'BAMLH0A0HYM2' }, transform: { kind: 'level' },
    ...DAILY, weight: 1, dir: +1, unit: '%', publishRaw: false },

  // ---- Inflation impulse ----------------------------------------------------
  { id: 'breakeven', gauge: 'inflation', label: '10y breakeven inflation, 20-day change', chain: 'inflation',
    source: { type: 'fred', id: 'T10YIE' }, transform: { kind: 'chg', n: 20 },
    ...DAILY, weight: 0.40, dir: +1, unit: 'pp' },
  { id: 'cpi', gauge: 'inflation', label: 'CPI inflation, year on year',
    source: { type: 'fred', id: 'CPIAUCSL' }, transform: { kind: 'yoy', n: 12 },
    window: 120, lagDays: 45, maxAgeDays: 80, weight: 0.30, dir: +1, unit: '%' },
  { id: 'core_cpi', gauge: 'inflation', label: 'Core CPI, year on year',
    source: { type: 'fred', id: 'CPILFESL' }, transform: { kind: 'yoy', n: 12 },
    window: 120, lagDays: 45, maxAgeDays: 80, weight: 0.30, dir: +1, unit: '%' },

  // ---- Rate & dollar headwind ----------------------------------------------
  { id: 'fed_path', gauge: 'headwind', label: '2y yield minus Fed ceiling (hikes priced if > 0)', chain: 'fed',
    source: { type: 'spread', a: 'DGS2', b: 'DFEDTARU' }, transform: { kind: 'level' },
    ...DAILY, weight: 0.25, dir: +1, unit: 'pp' },
  { id: 'y2_chg', gauge: 'headwind', label: '2y Treasury yield, 20-day change',
    source: { type: 'fred', id: 'DGS2' }, transform: { kind: 'chg', n: 20 },
    ...DAILY, weight: 0.20, dir: +1, unit: 'pp' },
  { id: 'real_yield', gauge: 'headwind', label: '10y real yield (TIPS), 20-day change', chain: 'real',
    source: { type: 'fred', id: 'DFII10' }, transform: { kind: 'chg', n: 20 },
    ...DAILY, weight: 0.30, dir: +1, unit: 'pp' },
  { id: 'dollar', gauge: 'headwind', label: 'Broad US dollar, 20-day change', chain: 'usd',
    source: { type: 'fred', id: 'DTWEXBGS' }, transform: { kind: 'pct', n: 20 },
    ...DAILY, lagDays: 7, maxAgeDays: 14, weight: 0.25, dir: +1, unit: '%' },

  // ---- Positioning ----------------------------------------------------------
  { id: 'cot_gold', gauge: 'flows', label: 'Managed money net long, gold (% of OI)',
    source: { type: 'cot', code: '088691' }, transform: { kind: 'level' },
    window: 156, lagDays: 3, maxAgeDays: 12, weight: 0.5, dir: +1, unit: '%' },
  { id: 'gld_flow', gauge: 'flows', label: 'Gold ETF holdings (GLD), 20-day change',
    source: { type: 'gld' }, transform: { kind: 'pct', n: 20 },
    ...DAILY, weight: 0.5, dir: +1, unit: '%', publishRaw: false },
];

// Raw levels shown on the dashboard alongside the scores (not scored).
export const DISPLAY = {
  brent:   { label: 'Brent', source: { type: 'fred', id: 'DCOILBRENTEU' }, unit: '$' },
  wti:     { label: 'WTI', source: { type: 'fred', id: 'DCOILWTICO' }, unit: '$' },
  fedUpper:{ label: 'Fed funds ceiling', source: { type: 'fred', id: 'DFEDTARU' }, unit: '%' },
  y2:      { label: '2y yield', source: { type: 'fred', id: 'DGS2' }, unit: '%' },
  y10:     { label: '10y yield', source: { type: 'fred', id: 'DGS10' }, unit: '%' },
  real10:  { label: '10y real yield', source: { type: 'fred', id: 'DFII10' }, unit: '%' },
  be10:    { label: '10y breakeven', source: { type: 'fred', id: 'T10YIE' }, unit: '%' },
  usdinr:  { label: 'USD/INR', source: { type: 'fred', id: 'DEXINUS' }, unit: '₹' },
  cotSilver: { label: 'Managed money net long, silver', source: { type: 'cot', code: '084691' }, unit: '%' },
};

// Alert thresholds. Cooldown stops the same alert repeating every run.
export const ALERTS = {
  cooldownHours: 72,           // same alert at most once every 3 days
  liquidityGate: 90,           // credit-spread rank above this = dash-for-cash risk
  zoneHysteresis: 3,           // points the meter must clear past a zone edge before the zone flips
  warZ: 2.0,                   // war threats or acts, z-score of the 7-day average
  oilJumpPct: 8,               // Brent move over 5 sessions
  vixLevel: 30,
  hawkish2yBp: 25,             // 2y yield rise over 10 sessions, basis points
  realYieldBp: 20,             // 10y real yield rise over 10 sessions
  dollarJumpPct: 2,            // broad dollar over 10 sessions
  tugOfWar: 65,                // fear AND headwind both above this
};

export const ZONES = [
  { max: 25,  key: 'risk_on',  label: 'Risk-on' },
  { max: 45,  key: 'calm',     label: 'Calm' },
  { max: 60,  key: 'watch',    label: 'Watchful' },
  { max: 75,  key: 'elevated', label: 'Elevated' },
  { max: 101, key: 'haven',    label: 'Safe-haven ON' },
];
