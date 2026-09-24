import { renderHttpError } from '@velajs/vela';
import { describe, expect, it } from 'vitest';
import {
  ConfigurationException,
  CrudException,
  InputValidationException,
  NotFoundException,
} from '../errors';

describe('CrudException rendering', () => {
  it('owns its envelope through toResponse()', () => {
    const error = new NotFoundException('Post', '7');
    expect(error.message).toBe("Post with id '7' not found");
    expect(error.toResponse()).toEqual({
      status: 404,
      body: { success: false, error: { code: 'NOT_FOUND', message: "Post with id '7' not found" } },
    });
    expect(error.getResponse()).toEqual({
      success: false,
      error: { code: 'NOT_FOUND', message: "Post with id '7' not found" },
    });
  });

  it('renders through the shared HTTP renderer with details', () => {
    const issues = [{ path: 'title', message: 'Required', code: 'invalid_type' }];
    expect(renderHttpError(new InputValidationException('Validation failed', issues))).toEqual({
      status: 400,
      body: {
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Validation failed', details: issues },
      },
      redacted: false,
    });
  });

  it('is redacted on the raw Hono edge when it is a server fault', () => {
    const rendered = renderHttpError(new ConfigurationException('adapter secret missing'), {
      redactServerBodies: true,
    });
    expect(rendered.status).toBe(500);
    expect(JSON.stringify(rendered.body)).not.toContain('adapter secret');
    expect(new CrudException('boom').toResponse().status).toBe(500);
  });
});
