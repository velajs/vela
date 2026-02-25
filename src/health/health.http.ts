import { Injectable } from '../container/index';
import { HealthIndicatorService } from './health.indicator';
import type { HealthIndicatorResult, ResponseCheckCallback } from './health.types';

export interface HttpPingOptions {
  method?: string;
  headers?: Record<string, string>;
  timeout?: number;
  expectedStatus?: number;
}

@Injectable()
export class HttpHealthIndicator {
  constructor(private indicator: HealthIndicatorService) {}

  async pingCheck(
    key: string,
    url: string,
    options?: HttpPingOptions,
  ): Promise<HealthIndicatorResult> {
    const { method = 'GET', headers, timeout = 5000, expectedStatus } = options ?? {};

    try {
      const response = await fetch(url, {
        method,
        headers,
        signal: AbortSignal.timeout(timeout),
      });

      const statusCode = response.status;
      const isHealthy = expectedStatus !== undefined
        ? statusCode === expectedStatus
        : statusCode >= 200 && statusCode < 300;

      if (isHealthy) {
        return this.indicator.check(key).up({ statusCode });
      }

      return this.indicator.check(key).down({ statusCode, message: response.statusText });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return this.indicator.check(key).down({ message });
    }
  }

  async responseCheck(
    key: string,
    url: string,
    callback: ResponseCheckCallback,
    options?: HttpPingOptions,
  ): Promise<HealthIndicatorResult> {
    const { method = 'GET', headers, timeout = 5000 } = options ?? {};

    try {
      const response = await fetch(url, {
        method,
        headers,
        signal: AbortSignal.timeout(timeout),
      });

      const statusCode = response.status;
      const isHealthy = await callback(response);

      if (isHealthy) {
        return this.indicator.check(key).up({ statusCode });
      }

      return this.indicator.check(key).down({ statusCode });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return this.indicator.check(key).down({ message });
    }
  }
}
