import { defineConfig } from 'vitest/config';
import { oxc } from './oxc.config.ts';

export default defineConfig({ oxc, test: { include: ['test/*.test.ts'] } });
