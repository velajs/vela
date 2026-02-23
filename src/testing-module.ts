import type { Container, Token, VelaApplication } from '@velajs/vela';

export class TestingModule {
  constructor(
    private readonly app: VelaApplication,
    private readonly container: Container,
  ) {}

  get<T>(token: Token<T>): T {
    return this.container.resolve(token);
  }

  async createApplication(): Promise<VelaApplication> {
    await this.app.initRoutes();
    return this.app;
  }

  async close(signal?: string): Promise<void> {
    await this.app.close(signal);
  }
}
