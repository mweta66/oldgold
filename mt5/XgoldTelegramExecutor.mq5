#property copyright "Xgold"
#property version "1.00"
#property strict
#property description "Two 0.01 gold positions per confirmed Telegram publication; stepped runner stop."
#include <Trade/Trade.mqh>
#include "XgoldExecutionRules.mqh"

input bool Enabled=false;
input bool AllowRealAccount=false;
input long ExpectedAccountLogin=0;
input string BrokerSymbol="xauusd.s";
input string ExecutionToken="";
input double VolumePerLeg=0.01;
input double MaxEntryDeviationUSD=1.0;
input double MaxSpreadUSD=0.60;
input double MaxSlippageUSD=0.20;
input int MaxOpenPairs=1;
input ulong Magic=67018001;
input bool ResetUncertainExecutionHalt=false;

const string Endpoint="https://wetagold.vercel.app/api/mt5/execution-feed";
CTrade trader;
string symbol_name="", prefix="", cursor_key="", lock_key="", halt_key="", last_state="";
ulong next_poll=0;
struct Signal
  {
   long id,created_ms,expires_ms;
   int direction,count;
   double entry,stop,tp[3];
  };

void State(const string text)
  {
   if(text!=last_state) { Print("Xgold executor: ",text); last_state=text; }
  }
bool ValidToken()
  {
   if(StringLen(ExecutionToken)!=64) return false;
   for(int i=0;i<64;i++)
     {
      ushort c=StringGetCharacter(ExecutionToken,i);
      if(!((c>='0' && c<='9') || (c>='a' && c<='f'))) return false;
     }
   return true;
  }
bool DigitsOnly(const string text)
  {
   if(StringLen(text)<1 || StringLen(text)>16) return false;
   for(int i=0;i<StringLen(text);i++)
      if(StringGetCharacter(text,i)<'0' || StringGetCharacter(text,i)>'9') return false;
   return true;
  }
string Key(const long id,const string field) { return prefix+IntegerToString(id)+"."+field; }
bool Put(const string key,const double value)
  {
   ResetLastError();
   return GlobalVariableSet(key,value)>0;
  }
bool FindSymbol()
  {
   if(SymbolSelect(BrokerSymbol,true)) { symbol_name=BrokerSymbol; return true; }
   string wanted=BrokerSymbol; StringToUpper(wanted);
   for(int i=0;i<SymbolsTotal(false);i++)
     {
      string candidate=SymbolName(i,false),upper=candidate; StringToUpper(upper);
      if(upper==wanted && SymbolSelect(candidate,true)) { symbol_name=candidate; return true; }
     }
   return false;
  }
bool TradingReady()
  {
   return Enabled && AccountInfoInteger(ACCOUNT_LOGIN)==ExpectedAccountLogin &&
      AccountInfoInteger(ACCOUNT_MARGIN_MODE)==ACCOUNT_MARGIN_MODE_RETAIL_HEDGING &&
      (AccountInfoInteger(ACCOUNT_TRADE_MODE)==ACCOUNT_TRADE_MODE_DEMO || AllowRealAccount) &&
      TerminalInfoInteger(TERMINAL_CONNECTED) && TerminalInfoInteger(TERMINAL_TRADE_ALLOWED) &&
      MQLInfoInteger(MQL_TRADE_ALLOWED) && AccountInfoInteger(ACCOUNT_TRADE_ALLOWED) &&
      AccountInfoInteger(ACCOUNT_TRADE_EXPERT);
  }
int OnInit()
  {
   if(!FindSymbol()) { State("Broker gold symbol not found. Check the exact suffix."); return INIT_PARAMETERS_INCORRECT; }
   if(VolumePerLeg<=0 || MaxEntryDeviationUSD<=0 || MaxEntryDeviationUSD>1 ||
      MaxSpreadUSD<=0 || MaxSlippageUSD<0 || MaxOpenPairs<1 || Magic==0 || Magic>2147483647)
      return INIT_PARAMETERS_INCORRECT;
   if(Enabled && (!ValidToken() || ExpectedAccountLogin<=0 ||
      AccountInfoInteger(ACCOUNT_LOGIN)!=ExpectedAccountLogin ||
      AccountInfoInteger(ACCOUNT_MARGIN_MODE)!=ACCOUNT_MARGIN_MODE_RETAIL_HEDGING ||
      (AccountInfoInteger(ACCOUNT_TRADE_MODE)!=ACCOUNT_TRADE_MODE_DEMO && !AllowRealAccount)))
     { State("Check pairing token, account login, hedging mode and real-account opt-in."); return INIT_PARAMETERS_INCORRECT; }
   prefix="XGE."+IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN))+"."+IntegerToString((long)Magic)+".";
   cursor_key=prefix+"cursor";lock_key=prefix+"lock";halt_key=prefix+"halt";
   if(StringLen(prefix)+24>63) return INIT_PARAMETERS_INCORRECT;
   if(!GlobalVariableTemp(lock_key)) return INIT_FAILED;
   if(ResetUncertainExecutionHalt && !Put(halt_key,0)) return INIT_FAILED;
   trader.SetExpertMagicNumber(Magic);trader.SetAsyncMode(false);
   if(!trader.SetTypeFillingBySymbol(symbol_name)) return INIT_FAILED;
   double point=SymbolInfoDouble(symbol_name,SYMBOL_POINT);
   if(point<=0) return INIT_FAILED;
   trader.SetDeviationInPoints((ulong)MathCeil(MaxSlippageUSD/point));
   if(!EventSetTimer(1)) return INIT_FAILED;
   State(Enabled ? "Ready. First connection skips historical signals." : "Disabled. No orders or stop changes.");
   return INIT_SUCCEEDED;
  }
void OnDeinit(const int reason) { EventKillTimer(); }

bool Acquire()
  {
   double old=GlobalVariableGet(lock_key),now=(double)TimeLocal();
   if(old!=0 && now-old<300) return false;
   return GlobalVariableSetOnCondition(lock_key,now,old);
  }
bool Quote(MqlTick &tick)
  {
   if(!SymbolInfoTick(symbol_name,tick) || tick.bid<=0 || tick.ask<tick.bid || tick.time_msc<=0) return false;
   // Broker/server clocks may have a UTC offset. Check tick age in broker time.
   return MathAbs((double)(TimeTradeServer()-(datetime)tick.time))<=10;
  }
double Snap(const double value,const bool up)
  {
   double step=SymbolInfoDouble(symbol_name,SYMBOL_TRADE_TICK_SIZE);
   if(step<=0) return 0;
   double n=up?MathCeil(value/step-1e-8):MathFloor(value/step+1e-8);
   return NormalizeDouble(n*step,(int)SymbolInfoInteger(symbol_name,SYMBOL_DIGITS));
  }
bool VolumeValid()
  {
   double step=SymbolInfoDouble(symbol_name,SYMBOL_VOLUME_STEP);
   return step>0 && VolumePerLeg>=SymbolInfoDouble(symbol_name,SYMBOL_VOLUME_MIN)-1e-9 &&
      VolumePerLeg<=SymbolInfoDouble(symbol_name,SYMBOL_VOLUME_MAX)+1e-9 &&
      MathAbs(VolumePerLeg/step-MathRound(VolumePerLeg/step))<1e-7;
  }
int OwnPairs()
  {
   long ids[];int unknown=0;
   for(int i=PositionsTotal()-1;i>=0;i--)
     {
      ulong ticket=PositionGetTicket(i);
      if(ticket==0 || PositionGetInteger(POSITION_MAGIC)!=(long)Magic || PositionGetString(POSITION_SYMBOL)!=symbol_name) continue;
      string comment=PositionGetString(POSITION_COMMENT);int colon=StringFind(comment,":");
      if(StringFind(comment,"XG")!=0 || colon<3) { unknown++;continue; }
      string text=StringSubstr(comment,2,colon-2);if(!DigitsOnly(text)) { unknown++;continue; }
      long id=StringToInteger(text);bool seen=false;
      for(int k=0;k<ArraySize(ids);k++) if(ids[k]==id) { seen=true;break; }
      if(!seen) { int n=ArraySize(ids);ArrayResize(ids,n+1);ids[n]=id; }
     }
   return ArraySize(ids)+unknown;
  }
bool EntryValid(Signal &s,MqlTick &tick,const int required_legs=1)
  {
   if(!Quote(tick) || tick.ask-tick.bid>MaxSpreadUSD || !VolumeValid()) return false;
   bool buy=s.direction==1;
   double fill=buy?tick.ask:tick.bid;
   if(MathAbs(fill-s.entry)>MaxEntryDeviationUSD) return false;
   if(buy ? tick.bid>=s.tp[0] : tick.ask<=s.tp[0]) return false;
   double stop=Snap(s.stop,!buy),tp=Snap(s.tp[0],!buy);
   double risk=MathAbs(s.entry-stop);
   double actual_risk=MathAbs(fill-stop);
   if(stop<=0 || risk<6-1e-7 || risk>10+1e-7 || actual_risk<6-1e-7 || actual_risk>10+1e-7) return false;
   double reward=buy?tp-fill:fill-tp;
   if(reward/actual_risk<1.2) return false;
   double minimum=(double)SymbolInfoInteger(symbol_name,SYMBOL_TRADE_STOPS_LEVEL)*SymbolInfoDouble(symbol_name,SYMBOL_POINT);
   // Stop levels are measured against the executable side, not the chart mid.
   if(buy ? (tick.bid-stop<=minimum || tp-tick.bid<=minimum) : (stop-tick.ask<=minimum || tick.ask-tp<=minimum)) return false;
   double margin=0;
   if(!OrderCalcMargin(buy?ORDER_TYPE_BUY:ORDER_TYPE_SELL,symbol_name,VolumePerLeg,fill,margin) ||
      AccountInfoDouble(ACCOUNT_MARGIN_FREE)<margin*required_legs) return false;
   s.stop=stop;
   return true;
  }
bool SaveLevels(Signal &s)
  {
   if(!Put(Key(s.id,"tp1"),s.tp[0]) || !Put(Key(s.id,"tp2"),s.tp[1]) ||
      !Put(Key(s.id,"tp3"),s.tp[2]) || !Put(Key(s.id,"count"),s.count) ||
      !Put(Key(s.id,"stage"),0) || !Put(Key(s.id,"tick"),0) || !Put(Key(s.id,"ready"),1)) return false;
   GlobalVariablesFlush();return true;
  }
void Halt()
  {
   Put(halt_key,1);GlobalVariablesFlush();
   State("Uncertain or partial execution. New entries halted; inspect broker positions/history before resetting.");
  }
bool SendLeg(Signal &s,const bool first)
  {
   MqlTick tick;if(!EntryValid(s,tick)) { State("Entry skipped: price, spread, volume or broker stop limits changed."); return false; }
   bool buy=s.direction==1;
   string comment="XG"+IntegerToString(s.id)+(first?":A":":B");
   double tp=first?Snap(s.tp[0],!buy):0;
   bool sent=buy?trader.Buy(VolumePerLeg,symbol_name,0,s.stop,tp,comment):trader.Sell(VolumePerLeg,symbol_name,0,s.stop,tp,comment);
   uint code=trader.ResultRetcode();
   if(sent && code==TRADE_RETCODE_DONE)
     {
      if(trader.ResultDeal()!=0 && MathAbs(trader.ResultVolume()-VolumePerLeg)<1e-8) return true;
      Halt();return false;
     }
   if(code==TRADE_RETCODE_TIMEOUT || code==TRADE_RETCODE_CONNECTION || code==TRADE_RETCODE_DONE_PARTIAL || code==TRADE_RETCODE_PLACED || code==0) Halt();
   else State("Order rejected by broker. This signal will not be retried.");
   return false;
  }
void Execute(Signal &s,const double old_cursor)
  {
   // Durable at-most-once ATTEMPT: reserve before contacting the broker.
   // A crash here can miss a trade; retrying an unknown fill can duplicate one.
   if(!GlobalVariableSetOnCondition(cursor_key,(double)s.id,old_cursor)) return;
   GlobalVariablesFlush();
   if(GlobalVariableCheck(halt_key) && GlobalVariableGet(halt_key)!=0) return;
   if(OwnPairs()>=MaxOpenPairs) { State("Signal skipped: configured open-pair limit."); return; }
   MqlTick tick;
   if(!EntryValid(s,tick,2)) { State("Signal skipped: price/spread/volume/stop validation."); return; }
   if(!SaveLevels(s)) { State("Cannot persist target levels. No orders sent."); return; }
   if(!SendLeg(s,true)) return;
   if(!SendLeg(s,false)) { State("Second leg unconfirmed. Inspect broker positions; neither leg is automatically retried."); return; }
   State("Two positions opened: A closes at TP1; B follows target steps.");
  }
void ManageRunners()
  {
   MqlTick tick;if(!Quote(tick)) return;
   double point=SymbolInfoDouble(symbol_name,SYMBOL_POINT);
   double minimum=(double)MathMax(SymbolInfoInteger(symbol_name,SYMBOL_TRADE_STOPS_LEVEL),SymbolInfoInteger(symbol_name,SYMBOL_TRADE_FREEZE_LEVEL))*point;
   for(int i=PositionsTotal()-1;i>=0;i--)
     {
      ulong ticket=PositionGetTicket(i);
      if(ticket==0 || PositionGetInteger(POSITION_MAGIC)!=(long)Magic || PositionGetString(POSITION_SYMBOL)!=symbol_name) continue;
      string comment=PositionGetString(POSITION_COMMENT);
      int colon=StringFind(comment,":B");
      if(StringFind(comment,"XG")!=0 || colon<3 || colon!=StringLen(comment)-2) continue;
      string number=StringSubstr(comment,2,colon-2);if(!DigitsOnly(number)) continue;
      long id=StringToInteger(number);
      if(!GlobalVariableCheck(Key(id,"ready")) || GlobalVariableGet(Key(id,"ready"))!=1) { State("Runner levels missing; broker SL remains in place."); continue; }
      int count=(int)GlobalVariableGet(Key(id,"count")),stage=(int)GlobalVariableGet(Key(id,"stage"));
      if(count<1 || count>3 || stage<0 || stage>3) continue;
      bool buy=PositionGetInteger(POSITION_TYPE)==POSITION_TYPE_BUY;
      double current=buy?tick.bid:tick.ask;
      double targets[3];targets[0]=GlobalVariableGet(Key(id,"tp1"));targets[1]=GlobalVariableGet(Key(id,"tp2"));targets[2]=GlobalVariableGet(Key(id,"tp3"));
      // Replay a bounded window of actual broker ticks, so a brief target touch
      // during synchronous WebRequest is not lost merely because price retraced.
      double extreme=current;
      long previous_tick=(long)GlobalVariableGet(Key(id,"tick"));
      long from=(long)MathMax((double)PositionGetInteger(POSITION_TIME_MSC),(double)(previous_tick+1));
      from=(long)MathMax((double)from,(double)(tick.time_msc-15000));
      if(from<=tick.time_msc)
        {
         MqlTick recent_ticks[];
         int n=CopyTicksRange(symbol_name,recent_ticks,COPY_TICKS_INFO,(ulong)from,(ulong)tick.time_msc);
         for(int k=0;k<n;k++)
           {
            double observed=buy?recent_ticks[k].bid:recent_ticks[k].ask;
            if(observed>0) extreme=buy?MathMax(extreme,observed):MathMin(extreme,observed);
           }
         if(n>=0) Put(Key(id,"tick"),(double)tick.time_msc);
        }
      int reached=XgoldReachedStage(buy?1:-1,extreme,targets,count,stage);
      if(reached>stage)
        { if(!Put(Key(id,"stage"),reached)) continue;GlobalVariablesFlush();stage=reached; }
      if(stage==0) continue;
      double desired=XgoldStageStop(stage,PositionGetDouble(POSITION_PRICE_OPEN),targets);
      desired=Snap(desired,!buy);
      double old=PositionGetDouble(POSITION_SL);
      if(desired<=0 || (buy ? desired<=old+point/2 : (old>0 && desired>=old-point/2))) continue;
      if(buy ? current-desired<=minimum : desired-current<=minimum) continue;
      if(!trader.PositionModify(ticket,desired,0) ||
         (trader.ResultRetcode()!=TRADE_RETCODE_DONE && trader.ResultRetcode()!=TRADE_RETCODE_NO_CHANGES))
         State("Stop step waiting: broker rejected modification; original SL is retained.");
     }
  }
bool Parse(const string body,long &server_ms,long &cursor,int &has_signal,Signal &s)
  {
   string text=body;StringTrimLeft(text);StringTrimRight(text);
   string f[];if(StringSplit(text,'\t',f)!=14 || f[0]!="XG1") return false;
   if(!DigitsOnly(f[1]) || !DigitsOnly(f[2]) || (f[3]!="0" && f[3]!="1")) return false;
   server_ms=StringToInteger(f[1]);cursor=StringToInteger(f[2]);has_signal=(int)StringToInteger(f[3]);
   if(server_ms<=0 || cursor<0 || cursor>9007199254740991) return false;
   if(has_signal==0) return true;
   if(!DigitsOnly(f[4]) || !DigitsOnly(f[5]) || !DigitsOnly(f[12]) || !DigitsOnly(f[13]) || (f[6]!="1" && f[6]!="-1")) return false;
   s.id=StringToInteger(f[4]);s.created_ms=StringToInteger(f[5]);s.direction=(int)StringToInteger(f[6]);
   s.entry=StringToDouble(f[7]);s.stop=StringToDouble(f[8]);s.count=(int)StringToInteger(f[12]);s.expires_ms=StringToInteger(f[13]);
   s.tp[0]=StringToDouble(f[9]);s.tp[1]=StringToDouble(f[10]);s.tp[2]=StringToDouble(f[11]);
   if(s.id<=0 || s.id!=cursor || s.count<1 || s.count>3 || s.entry<=0 || s.stop<=0 ||
      !MathIsValidNumber(s.entry) || !MathIsValidNumber(s.stop) ||
      server_ms<s.created_ms || server_ms-s.created_ms>60000 || s.expires_ms<=server_ms) return false;
   if(s.direction==1?s.stop>=s.entry:s.stop<=s.entry) return false;
   for(int i=0;i<s.count;i++)
      if(!MathIsValidNumber(s.tp[i]) || s.tp[i]<=0 || (s.direction==1?s.tp[i]<=(i==0?s.entry:s.tp[i-1]):s.tp[i]>=(i==0?s.entry:s.tp[i-1]))) return false;
   return true;
  }
void Poll()
  {
   if(GetTickCount64()<next_poll) return;
   next_poll=GetTickCount64()+2000;
   bool bootstrap=!GlobalVariableCheck(cursor_key);
   double old=bootstrap?-1:GlobalVariableGet(cursor_key);
   string url=Endpoint+"?after="+IntegerToString((long)old);
   string headers="Accept: text/tab-separated-values\r\nAuthorization: Bearer "+ExecutionToken+"\r\n";
   char request[],response[];ArrayResize(request,0);string response_headers;
   ulong started=GetTickCount64();
   int status=WebRequest("GET",url,headers,5000,request,response,response_headers);
   ulong elapsed=GetTickCount64()-started;
   if(status!=200 || elapsed>5000 || ArraySize(response)>4096) { State("Execution feed unavailable. No new orders."); return; }
   StringToLower(response_headers);
   if(StringFind(response_headers,"text/tab-separated-values")<0) { State("Unexpected feed response. No orders."); return; }
   long server_ms=0,cursor=0;int has_signal=0;Signal s;
   if(!Parse(CharArrayToString(response,0,-1,CP_UTF8),server_ms,cursor,has_signal,s) || MathAbs((double)(server_ms-(long)TimeGMT()*1000))>30000)
     { State("Invalid or stale feed / PC clock mismatch. No orders."); return; }
   if(bootstrap)
     { if(has_signal!=0 || !Put(cursor_key,(double)cursor)) return;GlobalVariablesFlush();State("Paired. Historical signals skipped.");return; }
   if(cursor<(long)old) { State("Feed cursor moved backwards. Inspect pairing; no orders."); return; }
   if(has_signal==0)
     { if(cursor>(long)old) { GlobalVariableSetOnCondition(cursor_key,(double)cursor,old);GlobalVariablesFlush(); }return; }
   if(s.id<=(long)old) return;
   Execute(s,old);
  }
void OnTimer()
  {
   if(!TradingReady()) return;
   if(!Acquire()) return;
   ManageRunners();
   Poll();
   GlobalVariableSet(lock_key,0);
  }

// Stop management also runs on broker ticks, independently of feed polling.
void OnTick()
  {
   if(!TradingReady() || !Acquire()) return;
   ManageRunners();
   GlobalVariableSet(lock_key,0);
  }
