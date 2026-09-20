import { describe, it, expect } from 'vitest';
import type { SeederResult } from '@velajs/vela/seeder';
import { formatSeedResults } from './format.js';

describe('formatSeedResults', () => {
  it('returns 0 and reports success when every seeder ran', () => {
    const logs: string[] = [];
    const results: SeederResult[] = [
      { name: 'UserSeeder', ok: true },
      { name: 'PostSeeder', ok: true },
    ];
    const code = formatSeedResults(results, (m) => logs.push(m));
    expect(code).toBe(0);
    expect(logs.some((l) => l.includes('✓ UserSeeder'))).toBe(true);
    expect(logs.join('\n')).toContain('2/2 seeders ran successfully');
  });

  it('returns 1 and includes the error when a seeder failed', () => {
    const logs: string[] = [];
    const results: SeederResult[] = [
      { name: 'UserSeeder', ok: true },
      { name: 'PostSeeder', ok: false, error: new Error('boom') },
    ];
    const code = formatSeedResults(results, (m) => logs.push(m));
    expect(code).toBe(1);
    expect(logs.some((l) => l.includes('✗ PostSeeder: boom'))).toBe(true);
    expect(logs.join('\n')).toContain('1/2 seeders ran successfully');
  });

  it('returns 0 for no seeders', () => {
    const logs: string[] = [];
    expect(formatSeedResults([], (m) => logs.push(m))).toBe(0);
    expect(logs).toContain('No seeders found.');
  });
});
