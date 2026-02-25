import type { VelaApplication } from '../application';
import type { Token } from '../container/types';

export class TestingModule {
  constructor(private readonly app: VelaApplication) {}

  get<T>(token: Token<T>): T {
    return this.app.get(token);
  }

  async close(signal?: string): Promise<void> {
    await this.app.close(signal);
  }

  createNestApplication(): VelaApplication {
    return this.app;
  }
}
