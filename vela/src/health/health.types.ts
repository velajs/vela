export type HealthCheckStatus = 'ok' | 'error' | 'shutting_down';

export interface HealthIndicatorResult {
  [key: string]: {
    status: 'up' | 'down';
    [key: string]: unknown;
  };
}

export interface HealthCheckResult {
  status: HealthCheckStatus;
  info: HealthIndicatorResult;
  error: HealthIndicatorResult;
  details: HealthIndicatorResult;
}

export type HealthIndicatorFunction = () => Promise<HealthIndicatorResult>;

export type ResponseCheckCallback = (response: Response) => boolean | Promise<boolean>;
