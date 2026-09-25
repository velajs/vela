import { UseInterceptors, type NestInterceptor } from '@velajs/vela';
import { CloudflareTracingInterceptor } from '@velajs/cloudflare/tracing';

// The emitted subpath works with the existing interceptor registration surface.
@UseInterceptors(CloudflareTracingInterceptor)
export class TracedHost {
  async read(): Promise<string> {
    return 'value';
  }
}

export const interceptor: NestInterceptor = new CloudflareTracingInterceptor();
