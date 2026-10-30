//+------------------------------------------------------------------+
//|                                            SafeHavenFilter.mqh   |
//|  Macro filter for gold EAs, fed by the Gold Safe-Haven Meter      |
//|  https://github.com/goldprabuda/safe-haven-meter                 |
//|                                                                  |
//|  What it does: every few minutes it downloads signal.json and    |
//|  tells your EA whether new longs / shorts / pyramid adds are     |
//|  allowed and how much to scale the lot size. It never opens or   |
//|  closes trades itself.                                           |
//|                                                                  |
//|  Setup: see integrations/mt5/README.md                           |
//|  1. Copy this file to  MQL5\Include\                             |
//|  2. MT5: Tools > Options > Expert Advisors >                     |
//|     tick "Allow WebRequest for listed URL" and add               |
//|     https://raw.githubusercontent.com                            |
//|  3. #include <SafeHavenFilter.mqh> in the EA and call the        |
//|     SHM_ functions (5 small edits, see README)                   |
//|                                                                  |
//|  Strategy Tester: WebRequest is not available there, so the      |
//|  filter switches itself off and backtests run unchanged.         |
//+------------------------------------------------------------------+
#ifndef SAFE_HAVEN_FILTER_MQH
#define SAFE_HAVEN_FILTER_MQH

input group "=== Safe-haven meter filter ==="
input bool   InpSHM_Enable       = true;    // Use the safe-haven meter
input string InpSHM_Url          = "https://raw.githubusercontent.com/goldprabuda/safe-haven-meter/main/docs/data/signal.json"; // Signal URL
input int    InpSHM_RefreshMin   = 15;      // Re-download every N minutes
input int    InpSHM_MaxAgeHours  = 8;       // Ignore the meter if older than this
input bool   InpSHM_FailClosed   = false;   // Block new trades if the meter is unavailable
input bool   InpSHM_UseLotFactor = true;    // Scale lots by the meter (0.5 in caution)
input bool   InpSHM_GatePyramid  = true;    // Block pyramid adds when the meter says so

struct SHMSignal
  {
   bool     loaded;      // parsed at least once
   datetime generated;   // GMT time the meter was computed
   double   meter;       // 0..100
   string   zone;        // risk_on / calm / watch / elevated / haven
   string   bias;        // bullish / bearish / caution / neutral
   string   regime;      // tightening / easing / neutral (Fed)
   string   flags;       // comma list, e.g. fed_tightening,tug_of_war
   int      allowLong;
   int      allowShort;
   int      pyramid;
   double   lotFactor;
  };

SHMSignal g_shm;
datetime  g_shmLastTry = 0;
string    g_shmError   = "not loaded yet";

//--- tiny JSON reader for flat objects: "key": value  or  "key": "text"
string SHM_JsonValue(const string json, const string key)
  {
   string pat = "\"" + key + "\":";
   int p = StringFind(json, pat);
   if(p < 0)
      return "";
   p += StringLen(pat);
   int n = StringLen(json);
   while(p < n && (StringGetCharacter(json, p) == ' ' || StringGetCharacter(json, p) == '\t'))
      p++;
   if(p >= n)
      return "";
   if(StringGetCharacter(json, p) == '"')
     {
      int e = StringFind(json, "\"", p + 1);
      if(e < 0)
         return "";
      return StringSubstr(json, p + 1, e - p - 1);
     }
   int e = p;
   while(e < n)
     {
      ushort c = StringGetCharacter(json, e);
      if(c == ',' || c == '}' || c == '\n' || c == '\r')
         break;
      e++;
     }
   string v = StringSubstr(json, p, e - p);
   StringTrimLeft(v);
   StringTrimRight(v);
   return v;
  }

//--- download and parse. Returns true on success.
bool SHM_Fetch()
  {
   if(MQLInfoInteger(MQL_TESTER) || MQLInfoInteger(MQL_OPTIMIZATION))
     {
      g_shmError = "off in Strategy Tester";
      return false;
     }
   char   body[], result[];
   string respHeaders;
   ResetLastError();
   int code = WebRequest("GET", InpSHM_Url, "Accept: application/json\r\n", 5000, body, result, respHeaders);
   if(code == -1)
     {
      int err = GetLastError();
      if(err == 4014)
         g_shmError = "add https://raw.githubusercontent.com in Tools > Options > Expert Advisors";
      else
         g_shmError = "WebRequest error " + IntegerToString(err);
      return false;
     }
   if(code != 200)
     {
      g_shmError = "HTTP " + IntegerToString(code);
      return false;
     }
   string json = CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8);
   long   gen  = StringToInteger(SHM_JsonValue(json, "generatedUnix"));
   string bias = SHM_JsonValue(json, "bias");
   if(gen <= 0 || bias == "")
     {
      g_shmError = "unexpected file format";
      return false;
     }
   g_shm.generated  = (datetime)gen;
   g_shm.meter      = StringToDouble(SHM_JsonValue(json, "meter"));
   g_shm.zone       = SHM_JsonValue(json, "zone");
   g_shm.bias       = bias;
   g_shm.regime     = SHM_JsonValue(json, "regime");
   g_shm.flags      = SHM_JsonValue(json, "flags");
   g_shm.allowLong  = (int)StringToInteger(SHM_JsonValue(json, "allowLong"));
   g_shm.allowShort = (int)StringToInteger(SHM_JsonValue(json, "allowShort"));
   g_shm.pyramid    = (int)StringToInteger(SHM_JsonValue(json, "pyramid"));
   g_shm.lotFactor  = StringToDouble(SHM_JsonValue(json, "lotFactor"));
   g_shm.loaded     = true;
   g_shmError       = "";
   return true;
  }

//--- call from OnInit (force=true) and from OnTimer / OnTick. Cheap: only downloads every InpSHM_RefreshMin.
void SHM_Update(bool force = false)
  {
   if(!InpSHM_Enable)
      return;
   datetime now = TimeLocal();
   if(!force && now - g_shmLastTry < InpSHM_RefreshMin * 60)
      return;
   g_shmLastTry = now;
   SHM_Fetch();
  }

int SHM_AgeMinutes()
  {
   if(!g_shm.loaded)
      return -1;
   return (int)((TimeGMT() - g_shm.generated) / 60);
  }

//--- true when we have a fresh reading to act on
bool SHM_Usable()
  {
   if(!InpSHM_Enable || !g_shm.loaded)
      return false;
   int age = SHM_AgeMinutes();
   return age >= 0 && age <= InpSHM_MaxAgeHours * 60;
  }

//--- what to do when the meter is unavailable or stale
bool SHM_Fallback() { return !InpSHM_FailClosed; }

bool SHM_AllowLong()
  {
   if(!InpSHM_Enable)
      return true;
   if(!SHM_Usable())
      return SHM_Fallback();
   return g_shm.allowLong == 1;
  }

bool SHM_AllowShort()
  {
   if(!InpSHM_Enable)
      return true;
   if(!SHM_Usable())
      return SHM_Fallback();
   return g_shm.allowShort == 1;
  }

bool SHM_AllowPyramid()
  {
   if(!InpSHM_Enable || !InpSHM_GatePyramid)
      return true;
   if(!SHM_Usable())
      return SHM_Fallback();
   return g_shm.pyramid == 1;
  }

double SHM_LotFactor()
  {
   if(!InpSHM_Enable || !InpSHM_UseLotFactor || !SHM_Usable())
      return 1.0;
   return MathMax(0.0, MathMin(1.0, g_shm.lotFactor));
  }

//--- scale lots by the meter, rounded down to the broker's volume step, never below the minimum
double SHM_AdjustLots(const string symbol, double lots)
  {
   double f = SHM_LotFactor();
   if(f >= 0.999)
      return lots;
   double step = SymbolInfoDouble(symbol, SYMBOL_VOLUME_STEP);
   double vmin = SymbolInfoDouble(symbol, SYMBOL_VOLUME_MIN);
   if(step <= 0)
      step = 0.01;
   double v = MathFloor(lots * f / step + 1e-9) * step;
   if(v < vmin)
      v = vmin;
   int digits = (int)MathMax(0, MathCeil(-MathLog10(step) - 1e-9));
   return NormalizeDouble(v, digits);
  }

//--- one line for Comment() or Print()
string SHM_Status()
  {
   if(!InpSHM_Enable)
      return "Safe-haven meter: off";
   if(!g_shm.loaded)
      return "Safe-haven meter: " + g_shmError;
   string s = StringFormat("Meter %.0f %s | Fed %s | bias %s | long %s short %s pyramid %s | lots x%.2f | %d min old",
                           g_shm.meter, g_shm.zone, g_shm.regime, g_shm.bias,
                           SHM_AllowLong() ? "ok" : "BLOCKED",
                           SHM_AllowShort() ? "ok" : "BLOCKED",
                           SHM_AllowPyramid() ? "ok" : "BLOCKED",
                           SHM_LotFactor(), SHM_AgeMinutes());
   if(!SHM_Usable())
      s += InpSHM_FailClosed ? " | STALE: new trades blocked" : " | STALE: ignored";
   if(g_shmError != "")
      s += " | last fetch: " + g_shmError;
   return s;
  }

#endif // SAFE_HAVEN_FILTER_MQH
//+------------------------------------------------------------------+
