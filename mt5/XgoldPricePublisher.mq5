#property copyright "Xgold"
#property version "1.00"
#property strict
#property description "Read-only XAUUSD price publisher for MetaTrader Virtual Hosting. No trade operations."

input bool Enabled=false;
input string SourceSymbol="XAUUSD";
input string ExpectedServer="MetaQuotes-Demo";
input string BridgeToken="";
// Explicit broker clock conversion only. Incorrect offsets fail freshness checks.
input int BrokerUtcOffsetMinutes=0;

const string Endpoint="https://wetagold.vercel.app/api/mt5/ingest";
MqlRates initial_bars[];
int seed_position=0;
bool seeded=false;
ulong next_attempt=0;
int failures=0;
string last_state="";

void State(const string message)
  {
   if(message!=last_state) { Print("Xgold publisher: ",message); last_state=message; }
  }

bool ValidToken()
  {
   if(StringLen(BridgeToken)!=64) return false;
   for(int i=0;i<64;i++)
     {
      ushort c=StringGetCharacter(BridgeToken,i);
      if(!((c>='0' && c<='9') || (c>='a' && c<='f'))) return false;
     }
   return true;
  }

int OnInit()
  {
   if(SourceSymbol!="XAUUSD" || ExpectedServer!="MetaQuotes-Demo" ||
      BrokerUtcOffsetMinutes < -840 || BrokerUtcOffsetMinutes > 840)
      return INIT_PARAMETERS_INCORRECT;
   if(Enabled && !ValidToken()) { State("Configure the private bridge token first."); return INIT_PARAMETERS_INCORRECT; }
   if(!SymbolSelect(SourceSymbol,true)) { State("XAUUSD is unavailable."); return INIT_FAILED; }
   if(!EventSetTimer(1)) return INIT_FAILED;
   State(Enabled ? "Waiting for fresh broker data." : "Disabled. No data is sent.");
   return INIT_SUCCEEDED;
  }

void OnDeinit(const int reason) { EventKillTimer(); }

void OnTimer()
  {
   if(!Enabled || GetTickCount64()<next_attempt) return;
   if(!TerminalInfoInteger(TERMINAL_CONNECTED) || AccountInfoString(ACCOUNT_SERVER)!=ExpectedServer)
     { State("Disconnected or server mismatch. No data is sent."); return; }
   MqlTick tick;
   if(!SymbolInfoTick(SourceSymbol,tick) || !MathIsValidNumber(tick.bid) || !MathIsValidNumber(tick.ask) ||
      tick.bid<=0 || tick.ask<tick.bid || tick.time_msc<=0)
     { State("Waiting for a non-zero timestamped quote."); return; }
   long offset=(long)BrokerUtcOffsetMinutes*60000;
   long quote_ms=tick.time_msc-offset;
   long observed_ms=(long)TimeGMT()*1000+999;
   if(quote_ms<observed_ms-15000 || quote_ms>observed_ms+5000)
     { State("Quote is stale or the broker UTC offset is incorrect. No data is sent."); return; }
   observed_ms=MathMax(observed_ms,quote_ms);
   MqlRates rates[];
   ArraySetAsSeries(rates,false);
   if(!seeded && ArraySize(initial_bars)==0)
     {
      ArraySetAsSeries(initial_bars,false);
      if(CopyRates(SourceSymbol,PERIOD_M1,0,600,initial_bars)<=0)
        { State("Waiting for M1 broker history."); return; }
     }
   int count=0;
   if(!seeded)
     {
      count=MathMin(80,ArraySize(initial_bars)-seed_position);
      ArrayResize(rates,count);
      for(int i=0;i<count;i++) rates[i]=initial_bars[seed_position+i];
     }
   else
     {
      count=CopyRates(SourceSymbol,PERIOD_M1,0,2,rates);
      if(count<=0) { State("M1 history unavailable."); return; }
     }
   string bars="";
   for(int i=0;i<count;i++)
     {
      long bar_time=(long)rates[i].time-(long)BrokerUtcOffsetMinutes*60;
      if(bar_time*1000<observed_ms-604800000) continue;
      if(bars!="") bars+=",";
      bars+=StringFormat("{\"time\":%I64d,\"open\":%s,\"high\":%s,\"low\":%s,\"close\":%s,\"volume\":%I64d}",
        bar_time,DoubleToString(rates[i].open,8),DoubleToString(rates[i].high,8),
        DoubleToString(rates[i].low,8),DoubleToString(rates[i].close,8),rates[i].tick_volume);
     }
   string payload=StringFormat("{\"symbol\":\"XAUUSD\",\"server\":\"MetaQuotes-Demo\",\"timeMs\":%I64d,\"observedMs\":%I64d,\"bid\":%s,\"ask\":%s,\"bars\":[%s]}",
     quote_ms,observed_ms,DoubleToString(tick.bid,8),DoubleToString(tick.ask,8),bars);
   char request[],response[];
   StringToCharArray(payload,request,0,WHOLE_ARRAY,CP_UTF8);
   ArrayResize(request,ArraySize(request)-1);
   string headers="Content-Type: application/json\r\nAuthorization: Bearer "+BridgeToken+"\r\n";
   string response_headers;
   ResetLastError();
   int status=WebRequest("POST",Endpoint,headers,8000,request,response,response_headers);
   string body=CharArrayToString(response,0,-1,CP_UTF8);
   StringToLower(response_headers);
   if(status==200 && StringFind(response_headers,"application/json")>=0 && StringFind(body,"\"ok\":true")>=0)
     {
      failures=0;
      if(!seeded) { seed_position+=count; if(seed_position>=ArraySize(initial_bars)) { seeded=true; ArrayFree(initial_bars); } }
      State("Website confirmed delivery of broker prices.");
     }
   else
     {
      failures=MathMin(failures+1,5);
      next_attempt=GetTickCount64()+(ulong)MathMin(30000,1000*MathPow(2,failures));
      // Never print the authorization header, token, or response body.
      State(StringFormat("Delivery not confirmed (HTTP %d, local error %d). Check WebRequest permission, source status and server setup.",status,GetLastError()));
     }
  }
