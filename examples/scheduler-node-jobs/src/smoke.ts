import { createSchedulerNodeJobsApp } from './app.js';

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const { app, state } = await createSchedulerNodeJobsApp({
  intervalMs: 25,
});

const hono = app.getHonoApp();

console.log(await (await hono.request('/jobs/registry')).json());

await wait(90);
const beforeClose = { ...state, events: [...state.events] };
console.log(beforeClose);

await app.close('smoke');
await wait(60);

console.log({
  stopped: state.intervalTicks === beforeClose.intervalTicks,
  intervalTicks: state.intervalTicks,
});
