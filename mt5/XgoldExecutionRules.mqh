#ifndef XGOLD_EXECUTION_RULES
#define XGOLD_EXECUTION_RULES
// Pure step rules. No network, account access or order operations.
int XgoldReachedStage(const int direction,const double price,const double &targets[],const int count,const int previous)
  {
   int reached=previous;
   for(int i=0;i<count && i<3;i++)
      if(targets[i]>0 && (direction==1?price>=targets[i]:price<=targets[i])) reached=(int)MathMax(reached,i+1);
   return reached;
  }
double XgoldStageStop(const int stage,const double filled_entry,const double &targets[])
  {
   if(stage==1) return filled_entry;
   if(stage==2) return targets[0];
   if(stage==3) return targets[1];
   return 0;
  }
#endif
