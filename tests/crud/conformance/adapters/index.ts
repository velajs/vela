/**
 * Every adapter leg the conformance suite runs against. Cells `describe.each`
 * over this list — the cross-adapter behavior contract: one assertion set,
 * N adapters, zero drift.
 */
import type { AdapterDescriptor } from '../contract';
import { memoryConformance } from './memory';
import { drizzleConformance } from './drizzle';

export const conformanceAdapters: AdapterDescriptor[] = [memoryConformance, drizzleConformance];
