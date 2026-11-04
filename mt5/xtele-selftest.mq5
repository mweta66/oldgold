#property strict
#property script_show_inputs
#include "XgoldExecutionRules.mqh"
int failures=0;
void Expect(const bool ok,const string name)
  { if(!ok) { failures++;Print("FAIL: ",name); } }
void OnStart()
  {
   double buy[3]={4010,4020,4030},sell[3]={3990,3980,3970};
   Expect(XgoldReachedStage(1,4009,buy,3,0)==0,"buy before TP1");
   Expect(XgoldReachedStage(1,4010,buy,3,0)==1,"buy TP1");
   Expect(XgoldReachedStage(1,4020,buy,3,0)==2,"buy TP2 gap");
   Expect(XgoldReachedStage(1,4035,buy,3,0)==3,"buy TP3 gap");
   Expect(XgoldReachedStage(1,4011,buy,3,3)==3,"buy stage never retreats");
   Expect(XgoldReachedStage(-1,3991,sell,3,0)==0,"sell before TP1");
   Expect(XgoldReachedStage(-1,3990,sell,3,0)==1,"sell TP1");
   Expect(XgoldReachedStage(-1,3980,sell,3,0)==2,"sell TP2");
   Expect(XgoldReachedStage(-1,3960,sell,3,0)==3,"sell TP3 gap");
   Expect(XgoldReachedStage(-1,3985,sell,3,3)==3,"sell stage never retreats");
   Expect(XgoldStageStop(1,4000.25,buy)==4000.25,"actual filled entry at TP1");
   Expect(XgoldStageStop(2,4000,buy)==4010,"buy TP1 stop at TP2");
   Expect(XgoldStageStop(3,4000,buy)==4020,"buy TP2 stop at TP3");
   Expect(XgoldStageStop(2,4000,sell)==3990,"sell TP1 stop at TP2");
   Expect(XgoldStageStop(3,4000,sell)==3980,"sell TP2 stop at TP3");
   Print(failures==0?"PASS: all 15 xtele step-rule checks.":"FAIL: xtele rule checks: "+IntegerToString(failures));
  }
