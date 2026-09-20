import {
  Controller,
  Cron,
  Get,
  Injectable,
  Inject,
  InjectionToken,
  Interval,
  Module,
  ScheduleRegistry,
  VelaFactory,
} from '@velajs/vela';
import type { VelaApplication } from '@velajs/vela';
import { ScheduleExecutor, ScheduleNodeModule } from '@velajs/vela/schedule-node';

export interface SchedulerState {
  intervalTicks: number;
  cronTicks: number;
  events: string[];
}

export interface SchedulerOptions {
  intervalMs?: number;
  cronExpression?: string;
}

export interface SchedulerFixture {
  app: VelaApplication;
  state: SchedulerState;
}

const SCHEDULER_STATE = new InjectionToken<SchedulerState>('SCHEDULER_STATE');

export async function createSchedulerNodeJobsApp(
  options: SchedulerOptions = {},
): Promise<SchedulerFixture> {
  const intervalMs = options.intervalMs ?? 50;
  const cronExpression = options.cronExpression ?? '* * * * *';
  const state: SchedulerState = {
    intervalTicks: 0,
    cronTicks: 0,
    events: [],
  };

  @Injectable()
  class MaintenanceJobs {
    constructor(@Inject(SCHEDULER_STATE) private readonly schedulerState: SchedulerState) {}

    @Interval(intervalMs)
    pulse() {
      this.schedulerState.intervalTicks++;
      this.schedulerState.events.push(`interval:${this.schedulerState.intervalTicks}`);
    }

    @Cron(cronExpression)
    minute() {
      this.schedulerState.cronTicks++;
      this.schedulerState.events.push(`cron:${this.schedulerState.cronTicks}`);
    }
  }

  @Controller('/jobs')
  class JobsController {
    constructor(
      @Inject(SCHEDULER_STATE) private readonly schedulerState: SchedulerState,
      private readonly registry: ScheduleRegistry,
      private readonly executor: ScheduleExecutor,
    ) {}

    @Get('/state')
    currentState() {
      return this.schedulerState;
    }

    @Get('/registry')
    registryState() {
      return {
        hasExecutor: this.executor instanceof ScheduleExecutor,
        intervalJobs: this.registry.getIntervalJobs().map((job) => ({
          methodName: job.methodName,
          ms: job.ms,
        })),
        cronJobs: this.registry.getCronJobs().map((job) => ({
          methodName: job.methodName,
          expression: job.expression,
        })),
      };
    }
  }

  @Module({
    imports: [ScheduleNodeModule.forRoot()],
    providers: [
      MaintenanceJobs,
      { provide: SCHEDULER_STATE, useValue: state },
    ],
    controllers: [JobsController],
  })
  class SchedulerNodeJobsModule {}

  const app = await VelaFactory.create(SchedulerNodeJobsModule);
  return { app, state };
}
