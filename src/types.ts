export interface CloudflareEnv {
  [key: string]: unknown;
}

export interface ScheduledRegistration {
  instance: unknown;
  methodName: string;
  cron: string;
}

export interface QueueRegistration {
  instance: unknown;
  methodName: string;
  queueName: string;
}
