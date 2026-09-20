import { createApp } from './app.js';

// Module-level top-level await is allowed in Workers. The app singleton is
// constructed once per worker invocation context.
const app = await createApp();

export default app;
