export interface CronMetadata {
  expression: string;
  methodName: string;
}

export interface IntervalMetadata {
  ms: number;
  methodName: string;
}

export interface ScheduleModuleOptions {
  enableTimers?: boolean;
}
