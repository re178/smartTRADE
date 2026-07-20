//+------------------------------------------------------------------+
//|                                            MT5Bridge.mq5         |
//|          Production MT5 Bridge for RTS (Version 3.09)            |
//+------------------------------------------------------------------+
#property copyright "RTS Trading System"
#property link      "https://tradermarketopen.onrender.com"
#property version   "3.09"

#include <Trade/Trade.mqh>

// --- Inputs ---
input string   RENDER_URL         = "https://tradermarketopen.onrender.com";
input string   MT5_API_KEY        = "change-me-in-production";
input int      POLL_INTERVAL_SEC  = 5;
input int      PRICE_INTERVAL_SEC = 2;
input int      MAX_RETRIES        = 3;
input bool     DEBUG_MODE         = true;          // enable debug output
input int      MaxDeviation       = 20;
input int      MaxSpread          = 50;
input long     MagicNumber        = 123456;
input string   WatchedSymbols     = "EURUSD,GBPUSD,USDJPY,AUDUSD";

// --- Globals ---
#define MAX_CACHE 1000
#define RESULT_RETRY_MAX 3

CTrade        trade;
string        pendingUrl, claimUrl, resultUrl, statusUrl, heartbeatUrl, positionsUrl, syncUrl, priceUrl;
long          g_magic = MagicNumber;
bool          g_initialized = false;
int           g_failedRequests = 0;
bool          g_processing = false;

struct CacheEntry {
   string   commandId;
   ulong    tradeId;
   datetime time;
};
CacheEntry   g_cache[MAX_CACHE];
int          g_cacheIndex = 0;

int           g_heartbeatCounter = 0;
int           g_statusCounter = 0;
int           g_positionCounter = 0;
double        g_lastEquity = 0;
int           g_lastPosTotal = -1;
bool          g_serverOffline = false;
datetime      g_lastOfflineCheck = 0;
datetime      g_lastPriceTime = 0;

string        g_watchedSymbols[];
string        g_apiKey = "";
int           g_terminalLogin = 0;

//+------------------------------------------------------------------+
//| Helper: convert ulong to string                                  |
//+------------------------------------------------------------------+
string ULongToStr(ulong value) {
   return IntegerToString((long)value);
}

//+------------------------------------------------------------------+
//| Helper: convert ENUM_ORDER_TYPE to string                        |
//+------------------------------------------------------------------+
string OrderTypeToString(ENUM_ORDER_TYPE type) {
   switch(type) {
      case ORDER_TYPE_BUY:          return "BUY";
      case ORDER_TYPE_SELL:         return "SELL";
      case ORDER_TYPE_BUY_LIMIT:    return "BUY_LIMIT";
      case ORDER_TYPE_SELL_LIMIT:   return "SELL_LIMIT";
      case ORDER_TYPE_BUY_STOP:     return "BUY_STOP";
      case ORDER_TYPE_SELL_STOP:    return "SELL_STOP";
      case ORDER_TYPE_BUY_STOP_LIMIT: return "BUY_STOP_LIMIT";
      case ORDER_TYPE_SELL_STOP_LIMIT: return "SELL_STOP_LIMIT";
      default: return "UNKNOWN";
   }
}

ENUM_ORDER_TYPE StringToOrderType(string type) {
   if (type == "BUY") return ORDER_TYPE_BUY;
   if (type == "SELL") return ORDER_TYPE_SELL;
   if (type == "BUY_LIMIT") return ORDER_TYPE_BUY_LIMIT;
   if (type == "SELL_LIMIT") return ORDER_TYPE_SELL_LIMIT;
   if (type == "BUY_STOP") return ORDER_TYPE_BUY_STOP;
   if (type == "SELL_STOP") return ORDER_TYPE_SELL_STOP;
   if (type == "BUY_STOP_LIMIT") return ORDER_TYPE_BUY_STOP_LIMIT;
   if (type == "SELL_STOP_LIMIT") return ORDER_TYPE_SELL_STOP_LIMIT;
   return ORDER_TYPE_BUY;
}

//+------------------------------------------------------------------+
//| JSON Helpers (flat JSON only)                                    |
//+------------------------------------------------------------------+
string TrimSpaces(string str) {
   int start = 0, end = StringLen(str) - 1;
   while (start <= end && StringSubstr(str, start, 1) == " ") start++;
   while (end >= start && StringSubstr(str, end, 1) == " ") end--;
   return StringSubstr(str, start, end - start + 1);
}

string ExtractJsonString(string json, string key) {
   string search = "\"" + key + "\"";
   int pos = StringFind(json, search);
   if (pos == -1) return "";
   pos += StringLen(search);
   while (pos < StringLen(json) && (StringSubstr(json, pos, 1) == ":" || StringSubstr(json, pos, 1) == " ")) pos++;
   if (StringSubstr(json, pos, 1) != "\"") return "";
   pos++;
   string result = "";
   while (pos < StringLen(json)) {
      string ch = StringSubstr(json, pos, 1);
      if (ch == "\"") break;
      if (ch == "\\" && pos < StringLen(json) - 1) {
         string next = StringSubstr(json, pos + 1, 1);
         if (next == "n") { result += "\n"; pos += 2; continue; }
         if (next == "r") { result += "\r"; pos += 2; continue; }
         if (next == "t") { result += "\t"; pos += 2; continue; }
         if (next == "\"") { result += "\""; pos += 2; continue; }
         if (next == "\\") { result += "\\"; pos += 2; continue; }
      }
      result += ch;
      pos++;
   }
   return result;
}

double ExtractJsonDouble(string json, string key) {
   string search = "\"" + key + "\"";
   int pos = StringFind(json, search);
   if (pos == -1) return 0.0;
   pos += StringLen(search);
   while (pos < StringLen(json) && (StringSubstr(json, pos, 1) == ":" || StringSubstr(json, pos, 1) == " ")) pos++;
   string num = "";
   while (pos < StringLen(json)) {
      string ch = StringSubstr(json, pos, 1);
      if (ch == "," || ch == "}" || ch == "]") break;
      num += ch;
      pos++;
   }
   return StringToDouble(TrimSpaces(num));
}

int ExtractJsonInt(string json, string key) {
   return (int)ExtractJsonDouble(json, key);
}

int CountJsonArray(string json) {
   int count = 0;
   int pos = StringFind(json, "[");
   if (pos == -1) return 0;
   int depth = 0;
   bool inString = false;
   for (int i = pos + 1; i < StringLen(json); i++) {
      string ch = StringSubstr(json, i, 1);
      if (ch == "\"" && (i == 0 || StringSubstr(json, i-1, 1) != "\\")) {
         inString = !inString;
      }
      if (!inString) {
         if (ch == "{") depth++;
         if (ch == "}") {
            depth--;
            if (depth == 0) count++;
         }
      }
   }
   return count;
}

string GetJsonArrayItem(string json, int index) {
   int pos = StringFind(json, "[");
   if (pos == -1) return "";
   int depth = 0;
   bool inString = false;
   int itemCount = 0;
   int start = -1;
   for (int i = pos + 1; i < StringLen(json); i++) {
      string ch = StringSubstr(json, i, 1);
      if (ch == "\"" && (i == 0 || StringSubstr(json, i-1, 1) != "\\")) {
         inString = !inString;
      }
      if (!inString) {
         if (ch == "{") {
            if (depth == 0 && itemCount == index) start = i;
            depth++;
         }
         if (ch == "}") {
            depth--;
            if (depth == 0) {
               if (itemCount == index && start != -1) {
                  return StringSubstr(json, start, i - start + 1);
               }
               itemCount++;
            }
         }
      }
   }
   return "";
}

string EscapeJson(string str) {
   StringReplace(str, "\\", "\\\\");
   StringReplace(str, "\"", "\\\"");
   StringReplace(str, "\r\n", "\\n");
   StringReplace(str, "\n", "\\n");
   StringReplace(str, "\r", "\\r");
   StringReplace(str, "\t", "\\t");
   return str;
}

//+------------------------------------------------------------------+
//| Command Cache                                                    |
//+------------------------------------------------------------------+
bool IsCommandProcessed(string cmdId, ulong tradeId) {
   for (int i = 0; i < MAX_CACHE; i++) {
      if (g_cache[i].commandId == cmdId && g_cache[i].tradeId == tradeId) {
         if (TimeCurrent() - g_cache[i].time > 3600) return false;
         return true;
      }
   }
   return false;
}

void AddCommandToCache(string cmdId, ulong tradeId) {
   g_cache[g_cacheIndex].commandId = cmdId;
   g_cache[g_cacheIndex].tradeId = tradeId;
   g_cache[g_cacheIndex].time = TimeCurrent();
   g_cacheIndex = (g_cacheIndex + 1) % MAX_CACHE;
}

void CleanCache() {
   static datetime lastClean = 0;
   if (TimeCurrent() - lastClean < 300) return;
   for (int i = 0; i < MAX_CACHE; i++) {
      if (g_cache[i].time > 0 && TimeCurrent() - g_cache[i].time > 3600) {
         g_cache[i].commandId = "";
         g_cache[i].tradeId = 0;
         g_cache[i].time = 0;
      }
   }
   lastClean = TimeCurrent();
}

//+------------------------------------------------------------------+
//| WebRequestEx with debug and detailed logging                     |
//+------------------------------------------------------------------+
int WebRequestEx(string method, string url, string headers, int timeout,
                 string data, string &response, string &responseHeaders) {
   if (g_serverOffline) {
      if (TimeCurrent() - g_lastOfflineCheck < 60) return -1;
      g_lastOfflineCheck = TimeCurrent();
   }

   string fullHeaders = headers;
   if (g_apiKey != "") {
      if (StringFind(headers, "X-API-Key") == -1) {
         fullHeaders = headers + "X-API-Key: " + g_apiKey + "\r\n";
      }
   }

   char requestData[], responseData[];
   if (data != "") StringToCharArray(data, requestData);
   else ArrayResize(requestData, 0);

   int res = -1;
   int lastError = 0;

   for (int attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      ResetLastError();
      res = WebRequest(method, url, fullHeaders, timeout, requestData, responseData, responseHeaders);
      lastError = GetLastError();

      // Print detailed debug info
      if (DEBUG_MODE || res != 200) {
         Print("📡 WebRequest | attempt=", attempt,
               " res=", res,
               " lastError=", lastError,
               " url=", url);
      }

      if (res == 200 || res == 201 || res == 202 || res == 204) {
         g_failedRequests = 0;
         g_serverOffline = false;
         break;
      }
      if (attempt < MAX_RETRIES) {
         if (DEBUG_MODE || res != 200) {
            Print("⚠️ Attempt ", attempt, " failed (res=", res, ", lastError=", lastError, "), retrying...");
         }
         Sleep(500 * attempt);
      }
   }

   if (res == 200 || res == 201 || res == 202 || res == 204) {
      response = CharArrayToString(responseData);
   } else {
      g_failedRequests++;
      if (g_failedRequests > 20 && g_failedRequests % 5 == 0) {
         Print("🚨 Server unreachable: ", g_failedRequests, " consecutive failures. Stopping polling.");
         g_serverOffline = true;
         g_lastOfflineCheck = TimeCurrent();
      } else if (g_failedRequests > 10 && g_failedRequests % 5 == 0) {
         Print("⚠️ Multiple request failures (", g_failedRequests, ")");
      }
      response = "";
   }
   return res;
}

//+------------------------------------------------------------------+
//| Symbol Lookup                                                    |
//+------------------------------------------------------------------+
string FindSymbol(string baseSymbol) {
   StringReplace(baseSymbol, "_", "");
   StringToUpper(baseSymbol);
   if (SymbolSelect(baseSymbol, true)) return baseSymbol;

   string variants[];
   ArrayResize(variants, 12);
   variants[0] = baseSymbol;
   variants[1] = baseSymbol + ".r";
   variants[2] = baseSymbol + "m";
   variants[3] = baseSymbol + ".pro";
   variants[4] = baseSymbol + "-";
   variants[5] = baseSymbol + "_";
   variants[6] = baseSymbol + ".b";
   variants[7] = baseSymbol + ".c";
   variants[8] = baseSymbol + ".ecn";
   variants[9] = baseSymbol + ".stp";
   variants[10] = baseSymbol + ".d";
   variants[11] = baseSymbol + ".real";

   for (int i = 0; i < ArraySize(variants); i++) {
      if (SymbolSelect(variants[i], true)) {
         if (DEBUG_MODE) Print("✅ Found symbol: ", variants[i]);
         return variants[i];
      }
   }

   for (int i = 0; i < SymbolsTotal(false); i++) {
      string name = SymbolName(i, false);
      string upperName = name;
      StringToUpper(upperName);
      if (StringCompare(upperName, baseSymbol, false) == 0) {
         if (SymbolSelect(name, true)) {
            if (DEBUG_MODE) Print("✅ Found exact match: ", name);
            return name;
         }
      }
   }

   for (int i = 0; i < SymbolsTotal(false); i++) {
      string name = SymbolName(i, false);
      string upperName = name;
      StringToUpper(upperName);
      if (StringFind(upperName, baseSymbol) != -1) {
         if (StringLen(name) < StringLen(baseSymbol) + 3) {
            if (SymbolSelect(name, true)) {
               if (DEBUG_MODE) Print("✅ Found symbol by partial match: ", name);
               return name;
            }
         }
      }
   }
   return "";
}

//+------------------------------------------------------------------+
//| Trade Validation                                                 |
//+------------------------------------------------------------------+
bool ValidateTrade(string symbol, double volume, double &outVolume, ENUM_ORDER_TYPE orderType, double price, double &marginReq) {
   ENUM_SYMBOL_TRADE_MODE mode = (ENUM_SYMBOL_TRADE_MODE)SymbolInfoInteger(symbol, SYMBOL_TRADE_MODE);
   if (mode == SYMBOL_TRADE_MODE_DISABLED) {
      Print("❌ Trading disabled for: ", symbol);
      return false;
   }

   double minVol = SymbolInfoDouble(symbol, SYMBOL_VOLUME_MIN);
   double maxVol = SymbolInfoDouble(symbol, SYMBOL_VOLUME_MAX);
   double stepVol = SymbolInfoDouble(symbol, SYMBOL_VOLUME_STEP);

   if (volume < minVol) volume = minVol;
   if (volume > maxVol) volume = maxVol;
   if (stepVol > 0) volume = MathRound(volume / stepVol) * stepVol;
   outVolume = volume;

   if (volume < minVol || volume > maxVol) {
      Print("❌ Volume invalid: ", volume);
      return false;
   }

   if (!OrderCalcMargin(orderType, symbol, volume, price, marginReq)) {
      Print("❌ Margin calc failed: ", GetLastError());
      return false;
   }
   double freeMargin = AccountInfoDouble(ACCOUNT_MARGIN_FREE);
   if (marginReq > freeMargin) {
      Print("❌ Insufficient margin. Need: ", marginReq, " Available: ", freeMargin);
      return false;
   }

   double ask = SymbolInfoDouble(symbol, SYMBOL_ASK);
   double bid = SymbolInfoDouble(symbol, SYMBOL_BID);
   double point = SymbolInfoDouble(symbol, SYMBOL_POINT);
   if (point == 0) { Print("❌ Zero point for ", symbol); return false; }
   int spreadPoints = (int)((ask - bid) / point);
   if (spreadPoints > MaxSpread) {
      Print("❌ Spread too high: ", spreadPoints, " > ", MaxSpread);
      return false;
   }
   return true;
}

//+------------------------------------------------------------------+
//| JSON Builders                                                    |
//+------------------------------------------------------------------+
string BuildResultJson(string cmdId, bool success, ulong ticket, ulong deal, double price, double volume,
                       string symbol, string side, int retcode, string retcodeDesc, string error) {
   string json = "{\"commandId\":\"" + EscapeJson(cmdId) + "\",";
   json += "\"success\":" + (success ? "true" : "false") + ",";
   json += "\"ticket\":" + ULongToStr(ticket) + ",";
   json += "\"deal\":" + ULongToStr(deal) + ",";
   json += "\"price\":" + DoubleToString(price, 8) + ",";
   json += "\"volume\":" + DoubleToString(volume, 2) + ",";
   json += "\"symbol\":\"" + EscapeJson(symbol) + "\",";
   json += "\"side\":\"" + EscapeJson(side) + "\",";
   json += "\"retcode\":" + IntegerToString(retcode) + ",";
   json += "\"retcodeDescription\":\"" + EscapeJson(retcodeDesc) + "\",";
   json += "\"time\":" + IntegerToString(TimeCurrent()) + ",";
   json += "\"error\":\"" + EscapeJson(error) + "\"}";
   return json;
}

string BuildStatusJson() {
   double marginLevel = AccountInfoDouble(ACCOUNT_MARGIN_LEVEL);
   if (marginLevel == 0) marginLevel = 0;
   string loginStr = IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN));
   string leverageStr = IntegerToString(AccountInfoInteger(ACCOUNT_LEVERAGE));
   string tradeModeStr = IntegerToString(AccountInfoInteger(ACCOUNT_TRADE_MODE));
   return "{\"login\":" + loginStr +
          ",\"balance\":" + DoubleToString(AccountInfoDouble(ACCOUNT_BALANCE), 2) +
          ",\"equity\":" + DoubleToString(AccountInfoDouble(ACCOUNT_EQUITY), 2) +
          ",\"margin\":" + DoubleToString(AccountInfoDouble(ACCOUNT_MARGIN), 2) +
          ",\"free_margin\":" + DoubleToString(AccountInfoDouble(ACCOUNT_MARGIN_FREE), 2) +
          ",\"profit\":" + DoubleToString(AccountInfoDouble(ACCOUNT_PROFIT), 2) +
          ",\"server\":\"" + EscapeJson(AccountInfoString(ACCOUNT_SERVER)) + "\"" +
          ",\"currency\":\"" + EscapeJson(AccountInfoString(ACCOUNT_CURRENCY)) + "\"" +
          ",\"leverage\":" + leverageStr +
          ",\"marginLevel\":" + DoubleToString(marginLevel, 2) +
          ",\"tradeMode\":" + tradeModeStr +
          ",\"company\":\"" + EscapeJson(AccountInfoString(ACCOUNT_COMPANY)) + "\"" +
          ",\"accountName\":\"" + EscapeJson(AccountInfoString(ACCOUNT_NAME)) + "\"" +
          ",\"timestamp\":" + IntegerToString(TimeCurrent()) +
          ",\"status\":\"online\"}";
}

string BuildPriceJson(string symbol) {
   MqlTick tick;
   if (!SymbolInfoTick(symbol, tick)) return "";
   double point = SymbolInfoDouble(symbol, SYMBOL_POINT);
   if (point <= 0) return "";
   int digits = (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS);
   double tickSize = SymbolInfoDouble(symbol, SYMBOL_TRADE_TICK_SIZE);
   double tickValue = SymbolInfoDouble(symbol, SYMBOL_TRADE_TICK_VALUE);
   int spread = (int)SymbolInfoInteger(symbol, SYMBOL_SPREAD);
   return "{\"symbol\":\"" + EscapeJson(symbol) + "\"," +
          "\"bid\":" + DoubleToString(tick.bid, digits) + "," +
          "\"ask\":" + DoubleToString(tick.ask, digits) + "," +
          "\"spread\":" + IntegerToString(spread) + "," +
          "\"digits\":" + IntegerToString(digits) + "," +
          "\"point\":" + DoubleToString(point, 8) + "," +
          "\"tick_size\":" + DoubleToString(tickSize, 8) + "," +
          "\"tick_value\":" + DoubleToString(tickValue, 8) + "," +
          "\"time\":" + IntegerToString(TimeCurrent()) + "}";
}

//+------------------------------------------------------------------+
//| OnInit                                                           |
//+------------------------------------------------------------------+
int OnInit() {
   g_apiKey = MT5_API_KEY;
   g_terminalLogin = (int)AccountInfoInteger(ACCOUNT_LOGIN);

   pendingUrl    = RENDER_URL + "/api/mt5/orders/pending";
   claimUrl      = RENDER_URL + "/api/mt5/orders/claim";
   resultUrl     = RENDER_URL + "/api/mt5/orders/result";
   statusUrl     = RENDER_URL + "/api/mt5/account/status";
   heartbeatUrl  = RENDER_URL + "/api/mt5/heartbeat";
   positionsUrl  = RENDER_URL + "/api/mt5/positions";
   syncUrl       = RENDER_URL + "/api/mt5/sync";
   priceUrl      = RENDER_URL + "/api/mt5/price";

   trade.SetExpertMagicNumber(g_magic);

   StringSplit(WatchedSymbols, ',', g_watchedSymbols);
   for (int i = 0; i < ArraySize(g_watchedSymbols); i++) {
      g_watchedSymbols[i] = TrimSpaces(g_watchedSymbols[i]);
   }

   EventSetTimer(POLL_INTERVAL_SEC);
   g_initialized = true;

   Print("✅ MT5 Bridge started (v3.09)");
   Print("📊 Account: ", AccountInfoInteger(ACCOUNT_LOGIN), " | Server: ", AccountInfoString(ACCOUNT_SERVER));
   Print("💼 Balance: ", AccountInfoDouble(ACCOUNT_BALANCE), " | Equity: ", AccountInfoDouble(ACCOUNT_EQUITY));
   if (g_apiKey == "" || g_apiKey == "change-me-in-production") {
      Print("⚠️  MT5_API_KEY not set – requests will be unauthenticated");
   } else {
      Print("🔑 API Key set (length: ", StringLen(g_apiKey), ")");
   }
   Print("⚠️  Ensure URL is added to Tools → Options → Expert Advisors → Allow WebRequest.");
   Print("🔗 Using RENDER_URL: ", RENDER_URL);

   // Startup sync
   string syncPayload = "{\"login\":" + IntegerToString(g_terminalLogin) +
                        ",\"status\":\"started\",\"timestamp\":" + IntegerToString(TimeCurrent()) +
                        ",\"magic\":" + IntegerToString((int)g_magic) + ",\"version\":\"3.09\"}";
   string headers = "Content-Type: application/json\r\n";
   string response, respHeaders;
   int syncRes = WebRequestEx("POST", syncUrl, headers, 10000, syncPayload, response, respHeaders);
   if (syncRes != 200 && syncRes != 201 && syncRes != 202) {
      Print("⚠️ Sync POST failed with res=", syncRes);
   }

   SendHeartbeat();
   SendAccountStatus();
   SendPositions();

   g_lastPriceTime = TimeCurrent();
   CleanCache();

   return(INIT_SUCCEEDED);
}

//+------------------------------------------------------------------+
//| OnDeinit                                                         |
//+------------------------------------------------------------------+
void OnDeinit(const int reason) {
   EventKillTimer();
   string payload = "{\"login\":" + IntegerToString(g_terminalLogin) +
                    ",\"status\":\"offline\",\"timestamp\":" + IntegerToString(TimeCurrent()) + "}";
   string headers = "Content-Type: application/json\r\n";
   string response, respHeaders;
   WebRequestEx("POST", heartbeatUrl, headers, 10000, payload, response, respHeaders);
   Print("🛑 MT5 Bridge stopped. Reason: ", reason);
}

//+------------------------------------------------------------------+
//| OnTimer with mutex                                               |
//+------------------------------------------------------------------+
void OnTimer() {
   if (!g_initialized || g_processing) return;
   g_processing = true;

   PollForCommands();

   g_heartbeatCounter++;
   if (g_heartbeatCounter >= 30 / POLL_INTERVAL_SEC) {
      SendHeartbeat();
      g_heartbeatCounter = 0;
   }

   g_statusCounter++;
   if (g_statusCounter >= 5 / POLL_INTERVAL_SEC) {
      SendAccountStatus();
      g_statusCounter = 0;
   }

   int posTotal = PositionsTotal();
   double equity = AccountInfoDouble(ACCOUNT_EQUITY);
   if (posTotal != g_lastPosTotal || MathAbs(equity - g_lastEquity) > 0.01) {
      SendPositions();
      SendAccountStatus();
      g_lastPosTotal = posTotal;
      g_lastEquity = equity;
   } else {
      g_positionCounter++;
      if (g_positionCounter >= 30 / POLL_INTERVAL_SEC) {
         SendPositions();
         g_positionCounter = 0;
      }
   }

   if (TimeCurrent() - g_lastPriceTime >= PRICE_INTERVAL_SEC) {
      SendAllPrices();
      g_lastPriceTime = TimeCurrent();
   }

   CleanCache();

   g_processing = false;
}

//+------------------------------------------------------------------+
//| Heartbeat                                                        |
//+------------------------------------------------------------------+
void SendHeartbeat() {
   if (g_serverOffline) return;
   string payload = "{\"login\":" + IntegerToString(g_terminalLogin) +
                    ",\"status\":\"online\",\"timestamp\":" + IntegerToString(TimeCurrent()) +
                    ",\"magic\":" + IntegerToString((int)g_magic) + "}";
   string headers = "Content-Type: application/json\r\n";
   string response, respHeaders;
   WebRequestEx("POST", heartbeatUrl, headers, 10000, payload, response, respHeaders);
}

//+------------------------------------------------------------------+
//| PollForCommands with claim and result retry                      |
//+------------------------------------------------------------------+
void PollForCommands() {
   string headers = "Content-Type: application/json\r\n";
   string response, respHeaders;

   int res = WebRequestEx("GET", pendingUrl, headers, 10000, "", response, respHeaders);
   if (res != 200) return;

   int count = CountJsonArray(response);
   if (count == 0) return;

   for (int i = 0; i < count; i++) {
      string jsonObj = GetJsonArrayItem(response, i);
      if (jsonObj == "") continue;

      string cmdId    = ExtractJsonString(jsonObj, "commandId");
      string action   = ExtractJsonString(jsonObj, "action");
      string symbol   = ExtractJsonString(jsonObj, "instrument");
      double volume   = ExtractJsonDouble(jsonObj, "units");
      string side     = ExtractJsonString(jsonObj, "side");
      double sl       = ExtractJsonDouble(jsonObj, "stopLoss");
      double tp       = ExtractJsonDouble(jsonObj, "takeProfit");
      ulong tradeId   = (ulong)ExtractJsonInt(jsonObj, "tradeId");
      string orderTypeStr = ExtractJsonString(jsonObj, "orderType");
      double orderPrice = ExtractJsonDouble(jsonObj, "price");
      double stopLimitPrice = ExtractJsonDouble(jsonObj, "stopLimitPrice");
      double closeVolume = ExtractJsonDouble(jsonObj, "volume");

      if (IsCommandProcessed(cmdId, tradeId)) {
         if (DEBUG_MODE) Print("⚠️ Duplicate ignored: ", cmdId);
         continue;
      }

      // Atomic claim
      string claimPayload = "{\"commandId\":\"" + cmdId + "\"}";
      string claimResponse, claimHeadersResp;
      int claimRes = WebRequestEx("POST", claimUrl,
                                  "Content-Type: application/json\r\n", 10000,
                                  claimPayload, claimResponse, claimHeadersResp);
      if (claimRes != 200 && claimRes != 201) {
         if (DEBUG_MODE) Print("⚠️ Claim failed for ", cmdId, " (HTTP ", claimRes, ") – skipping");
         continue;
      }

      // Execute command
      StringReplace(symbol, "_", "");
      string mt5Symbol = FindSymbol(symbol);
      if (mt5Symbol == "") {
         Print("❌ Symbol not found: ", symbol);
         SendResultWithRetry(cmdId, false, 0, 0, 0, 0, symbol, "", -1, "", "Symbol not found: " + symbol);
         continue;
      }

      if (!SymbolSelect(mt5Symbol, true)) {
         SendResultWithRetry(cmdId, false, 0, 0, 0, 0, mt5Symbol, "", -1, "", "Cannot select: " + mt5Symbol);
         continue;
      }

      MqlTick tick;
      if (!SymbolInfoTick(mt5Symbol, tick)) {
         SendResultWithRetry(cmdId, false, 0, 0, 0, 0, mt5Symbol, "", -1, "", "No tick data");
         continue;
      }

      bool success = false;
      string errorMsg = "";
      ulong ticket = 0;
      ulong deal = 0;
      double resultPrice = 0;
      double resultVolume = volume;
      int retcode = -1;
      string retcodeDesc = "";

      // --- Execute ---
      if (action == "OPEN") {
         ENUM_ORDER_TYPE orderType = StringToOrderType(orderTypeStr);
         bool isMarket = (orderTypeStr == "" || orderType == ORDER_TYPE_BUY || orderType == ORDER_TYPE_SELL);
         double price = 0;
         if (isMarket) {
            orderType = (side == "BUY") ? ORDER_TYPE_BUY : ORDER_TYPE_SELL;
            price = (side == "BUY") ? tick.ask : tick.bid;
            double marginReq = 0;
            double adjustedVolume = volume;
            if (!ValidateTrade(mt5Symbol, volume, adjustedVolume, orderType, price, marginReq)) {
               SendResultWithRetry(cmdId, false, 0, 0, 0, 0, mt5Symbol, side, -1, "", "Validation failed");
               continue;
            }
            resultVolume = adjustedVolume;
            trade.SetTypeFillingBySymbol(mt5Symbol);
            trade.SetDeviationInPoints(MaxDeviation);
            if (side == "BUY") {
               success = trade.Buy(adjustedVolume, mt5Symbol, tick.ask, sl, tp, "RTS Order");
            } else if (side == "SELL") {
               success = trade.Sell(adjustedVolume, mt5Symbol, tick.bid, sl, tp, "RTS Order");
            } else {
               errorMsg = "Invalid side: " + side;
            }
         } else {
            trade.SetTypeFillingBySymbol(mt5Symbol);
            trade.SetDeviationInPoints(MaxDeviation);
            double priceParam = orderPrice;
            if (priceParam == 0) {
               if (orderType == ORDER_TYPE_BUY_LIMIT || orderType == ORDER_TYPE_BUY_STOP_LIMIT)
                  priceParam = tick.bid;
               else if (orderType == ORDER_TYPE_SELL_LIMIT || orderType == ORDER_TYPE_SELL_STOP_LIMIT)
                  priceParam = tick.ask;
               else if (orderType == ORDER_TYPE_BUY_STOP)
                  priceParam = tick.ask + 10 * SymbolInfoDouble(mt5Symbol, SYMBOL_POINT);
               else if (orderType == ORDER_TYPE_SELL_STOP)
                  priceParam = tick.bid - 10 * SymbolInfoDouble(mt5Symbol, SYMBOL_POINT);
            }
            MqlTradeRequest request = {};
            MqlTradeResult result = {};
            request.action = TRADE_ACTION_PENDING;
            request.symbol = mt5Symbol;
            request.volume = volume;
            request.price = priceParam;
            request.sl = sl;
            request.tp = tp;
            request.type = orderType;
            request.type_filling = (ENUM_ORDER_TYPE_FILLING)(int)SymbolInfoInteger(mt5Symbol, SYMBOL_FILLING_MODE);
            request.deviation = MaxDeviation;
            request.magic = g_magic;
            request.comment = "RTS Pending";
            if (orderType == ORDER_TYPE_BUY_STOP_LIMIT || orderType == ORDER_TYPE_SELL_STOP_LIMIT) {
               request.stoplimit = stopLimitPrice;
            }
            success = OrderSend(request, result);
            if (success) {
               ticket = result.order;
               deal = result.deal;
               resultPrice = priceParam;
               retcode = result.retcode;
               retcodeDesc = IntegerToString((long)result.retcode_external);
            } else {
               retcode = result.retcode;
               retcodeDesc = IntegerToString((long)result.retcode_external);
               errorMsg = "OrderSend failed: " + IntegerToString(result.retcode) +
                          " External=" + IntegerToString((long)result.retcode_external);
            }
         }

         if (isMarket && success) {
            ticket = trade.ResultDeal();
            if (ticket == 0) {
               datetime latestTime = 0;
               int total = PositionsTotal();
               for (int p = 0; p < total; p++) {
                  ulong posTicket = PositionGetTicket(p);
                  if (PositionSelectByTicket(posTicket)) {
                     if (PositionGetInteger(POSITION_MAGIC) == g_magic &&
                         PositionGetString(POSITION_SYMBOL) == mt5Symbol) {
                        datetime openTime = (datetime)PositionGetInteger(POSITION_TIME);
                        if (openTime > latestTime) {
                           latestTime = openTime;
                           ticket = posTicket;
                        }
                     }
                  }
               }
            }
            if (ticket == 0) ticket = trade.ResultOrder();
            if (ticket > 0 && PositionSelectByTicket(ticket)) {
               resultPrice = PositionGetDouble(POSITION_PRICE_OPEN);
            } else {
               resultPrice = (side == "BUY") ? tick.ask : tick.bid;
            }
            retcode = trade.ResultRetcode();
            retcodeDesc = trade.ResultRetcodeDescription();
            deal = trade.ResultDeal();
         }
         if (!success && errorMsg == "") {
            errorMsg = "Trade failed: " + IntegerToString(trade.ResultRetcode()) +
                       " | " + trade.ResultRetcodeDescription();
         }
      }
      else if (action == "CLOSE") {
         if (tradeId > 0) {
            if (closeVolume > 0 && closeVolume < volume) {
               success = trade.PositionClosePartial(tradeId, closeVolume);
            } else {
               success = trade.PositionClose(tradeId);
            }
            if (success) {
               ticket = tradeId;
            } else {
               if (errorMsg == "") {
                  errorMsg = "Close failed: " + IntegerToString(trade.ResultRetcode()) +
                             " | " + trade.ResultRetcodeDescription();
               }
               retcode = trade.ResultRetcode();
               retcodeDesc = trade.ResultRetcodeDescription();
            }
         } else {
            errorMsg = "Invalid ticket: " + ULongToStr(tradeId);
         }
         if (success) {
            resultPrice = trade.ResultPrice();
            if (resultPrice == 0) resultPrice = tick.bid;
            deal = trade.ResultDeal();
            retcode = trade.ResultRetcode();
            retcodeDesc = trade.ResultRetcodeDescription();
         }
      }
      else if (action == "MODIFY") {
         if (tradeId > 0) {
            if (PositionSelectByTicket(tradeId)) {
               double currentSL = PositionGetDouble(POSITION_SL);
               double currentTP = PositionGetDouble(POSITION_TP);
               if (sl == 0) sl = currentSL;
               if (tp == 0) tp = currentTP;
               success = trade.PositionModify(tradeId, sl, tp);
            } else {
               errorMsg = "Position not found: " + ULongToStr(tradeId);
            }
         } else {
            errorMsg = "Invalid ticket: " + ULongToStr(tradeId);
         }
         if (success) {
            retcode = trade.ResultRetcode();
            retcodeDesc = trade.ResultRetcodeDescription();
            ticket = tradeId;
            resultPrice = 0;
         } else {
            if (errorMsg == "") {
               errorMsg = "Modify failed: " + IntegerToString(trade.ResultRetcode()) +
                          " | " + trade.ResultRetcodeDescription();
            }
            retcode = trade.ResultRetcode();
            retcodeDesc = trade.ResultRetcodeDescription();
         }
      }
      else if (action == "CANCEL") {
         if (tradeId > 0) {
            if (OrderSelect(tradeId)) {
               MqlTradeRequest request = {};
               MqlTradeResult result = {};
               request.action = TRADE_ACTION_REMOVE;
               request.order = tradeId;
               success = OrderSend(request, result);
               if (success) {
                  retcode = result.retcode;
                  retcodeDesc = IntegerToString((long)result.retcode_external);
                  ticket = tradeId;
               } else {
                  retcode = result.retcode;
                  retcodeDesc = IntegerToString((long)result.retcode_external);
                  errorMsg = "Cancel failed: " + IntegerToString(result.retcode) +
                             " External=" + IntegerToString((long)result.retcode_external);
               }
            } else {
               errorMsg = "Order not found: " + ULongToStr(tradeId);
            }
         } else {
            errorMsg = "Invalid ticket: " + ULongToStr(tradeId);
         }
      }
      else {
         errorMsg = "Unknown action: " + action;
      }

      if (success) Print("✅ ", action, " | ", cmdId, " | Ticket: ", ULongToStr(ticket));
      else Print("❌ ", action, " | ", cmdId, " | Error: ", errorMsg);

      SendResultWithRetry(cmdId, success, ticket, deal, resultPrice, resultVolume, mt5Symbol, side, retcode, retcodeDesc, errorMsg);
      AddCommandToCache(cmdId, ticket);
   }
}

//+------------------------------------------------------------------+
//| SendResultWithRetry                                              |
//+------------------------------------------------------------------+
void SendResultWithRetry(string cmdId, bool success, ulong ticket, ulong deal, double price, double volume,
                         string symbol, string side, int retcode, string retcodeDesc, string error) {
   string payload = BuildResultJson(cmdId, success, ticket, deal, price, volume, symbol, side, retcode, retcodeDesc, error);
   string headers = "Content-Type: application/json\r\n";
   string response, respHeaders;

   for (int attempt = 0; attempt < RESULT_RETRY_MAX; attempt++) {
      int res = WebRequestEx("POST", resultUrl, headers, 10000, payload, response, respHeaders);
      if (res == 200 || res == 201 || res == 202 || res == 204) {
         if (attempt > 0) Print("✅ Result sent after ", attempt+1, " attempts");
         return;
      }
      if (attempt < RESULT_RETRY_MAX - 1) {
         Print("⚠️ Result POST failed (", res, ") – retrying in 1s");
         Sleep(1000);
      }
   }
   Print("❌ Failed to send result after ", RESULT_RETRY_MAX, " attempts. Command may stay PROCESSING.");
}

//+------------------------------------------------------------------+
//| SendAccountStatus                                                |
//+------------------------------------------------------------------+
void SendAccountStatus() {
   if (g_serverOffline) return;
   string payload = BuildStatusJson();
   string headers = "Content-Type: application/json\r\n";
   string response, respHeaders;
   WebRequestEx("POST", statusUrl, headers, 10000, payload, response, respHeaders);
}

//+------------------------------------------------------------------+
//| SendPositions (ticket-based)                                     |
//+------------------------------------------------------------------+
void SendPositions() {
   if (g_serverOffline) return;
   string positions = "[";
   int total = PositionsTotal();
   int sent = 0;

   for (int i = 0; i < total; i++) {
      ulong ticket = PositionGetTicket(i);
      if (PositionSelectByTicket(ticket)) {
         if (PositionGetInteger(POSITION_MAGIC) != g_magic) continue;
         if (sent > 0) positions += ",";
         string symbol = PositionGetString(POSITION_SYMBOL);
         int digits = (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS);
         double point = SymbolInfoDouble(symbol, SYMBOL_POINT);
         double price = PositionGetDouble(POSITION_PRICE_OPEN);
         double currentPrice = PositionGetDouble(POSITION_PRICE_CURRENT);
         double sl = PositionGetDouble(POSITION_SL);
         double tp = PositionGetDouble(POSITION_TP);
         double profit = PositionGetDouble(POSITION_PROFIT);
         double swap = PositionGetDouble(POSITION_SWAP);
         double commission = 0;
         double volume = PositionGetDouble(POSITION_VOLUME);
         double margin = 0;
         if (!OrderCalcMargin(PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY ? ORDER_TYPE_BUY : ORDER_TYPE_SELL,
                              symbol, volume, price, margin)) {
            margin = 0;
         }
         positions += "{\"ticket\":" + ULongToStr(ticket) +
                      ",\"symbol\":\"" + EscapeJson(symbol) + "\"" +
                      ",\"type\":\"" + (PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY ? "BUY" : "SELL") + "\"" +
                      ",\"volume\":" + DoubleToString(volume, 2) +
                      ",\"price\":" + DoubleToString(price, digits) +
                      ",\"current_price\":" + DoubleToString(currentPrice, digits) +
                      ",\"profit\":" + DoubleToString(profit, 2) +
                      ",\"stop_loss\":" + DoubleToString(sl, digits) +
                      ",\"take_profit\":" + DoubleToString(tp, digits) +
                      ",\"swap\":" + DoubleToString(swap, 2) +
                      ",\"commission\":" + DoubleToString(commission, 2) +
                      ",\"margin\":" + DoubleToString(margin, 2) +
                      ",\"magic\":" + IntegerToString((int)PositionGetInteger(POSITION_MAGIC)) +
                      ",\"comment\":\"" + EscapeJson(PositionGetString(POSITION_COMMENT)) + "\"" +
                      ",\"open_time\":" + IntegerToString((int)PositionGetInteger(POSITION_TIME)) +
                      ",\"reason\":" + IntegerToString((int)PositionGetInteger(POSITION_REASON)) +
                      ",\"identifier\":" + ULongToStr((ulong)PositionGetInteger(POSITION_IDENTIFIER)) +
                      ",\"login\":" + IntegerToString(g_terminalLogin) +
                      "}";
         sent++;
      }
   }
   positions += "]";

   string payload = "{\"login\":" + IntegerToString(g_terminalLogin) +
                    ",\"positions\":" + positions +
                    ",\"timestamp\":" + IntegerToString(TimeCurrent()) +
                    ",\"magic\":" + IntegerToString((int)g_magic) + "}";

   string headers = "Content-Type: application/json\r\n";
   string response, respHeaders;
   WebRequestEx("POST", positionsUrl, headers, 10000, payload, response, respHeaders);
}

//+------------------------------------------------------------------+
//| SendAllPrices                                                    |
//+------------------------------------------------------------------+
void SendAllPrices() {
   if (g_serverOffline) return;
   string headers = "Content-Type: application/json\r\n";
   string response, respHeaders;
   for (int i = 0; i < ArraySize(g_watchedSymbols); i++) {
      string sym = g_watchedSymbols[i];
      if (sym == "") continue;
      string realSymbol = FindSymbol(sym);
      if (realSymbol == "") continue;
      string priceJson = BuildPriceJson(realSymbol);
      if (priceJson == "") continue;
      WebRequestEx("POST", priceUrl, headers, 10000, priceJson, response, respHeaders);
   }
}

//+------------------------------------------------------------------+
//| OnTradeTransaction (stub for future immediate updates)           |
//+------------------------------------------------------------------+
void OnTradeTransaction(const MqlTradeTransaction &trans,
                        const MqlTradeRequest &request,
                        const MqlTradeResult &result) {
   // Can be extended later for push‑based notifications.
}
//+------------------------------------------------------------------+
