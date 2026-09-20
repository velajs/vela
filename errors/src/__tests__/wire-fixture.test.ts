import { describe, expect, it } from 'vitest';
import { toErrorBody, VelaError } from '../index';

// GOLDEN: this exact JSON is the wire contract consumed by @velajs/client.
// Changing it is a breaking protocol change — bump consumers in lockstep.
describe('wire fixture', () => {
  it('canonical echoed body', () => {
    const { body } = toErrorBody(
      new VelaError('not_found', { message: 'no such route', hint: 'Run `vela route list`.' }),
    );
    expect(JSON.stringify(body)).toBe(
      '{"error":{"code":"not_found","message":"no such route","hint":"Run `vela route list`."}}',
    );
  });

  it('canonical redacted body', () => {
    const { body } = toErrorBody(new Error('x'));
    expect(JSON.stringify(body)).toBe(
      '{"error":{"code":"internal","message":"Internal Server Error"}}',
    );
  });
});
