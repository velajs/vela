import { Injectable } from '@velajs/vela';
import { Cron, type CronInvocation } from '@velajs/vela/schedule';
import { TodosService } from './todos.service.js';

@Injectable()
export class TodosCleanup {
  readonly #todos: TodosService;

  constructor(todos: TodosService) {
    this.#todos = todos;
  }

  // Runs on the matching Wrangler cron trigger ("triggers": { "crons": [...] }),
  // which Cloudflare evaluates in UTC with its own weekday numbering.
  @Cron('0 3 * * *', { dialect: 'cloudflare' })
  async purgeCompleted(_tick: CronInvocation): Promise<void> {
    await this.#todos.purgeCompleted();
  }
}
