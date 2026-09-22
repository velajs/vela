import { describe, expect, it } from 'vitest';
import { Reflector, getMetadata } from '../../index';

// Applications declare typed decorators at module scope. The pool evaluates
// test modules inside a request, so the global-scope restriction itself is
// covered by reflector-global-scope.test.ts; this proves the decorators work
// end-to-end under workerd.
const Audience = Reflector.createDecorator<string>();
const Region = Reflector.createDecorator<string>();

@Audience('internal')
class Report {
  @Region('eu')
  export() {}
}

describe('Reflector.createDecorator on Cloudflare Workers', () => {
  it('allocates distinct keys for decorators created at module scope', () => {
    expect(Audience.KEY).not.toBe(Region.KEY);
  });

  it('stores module-scope decorator metadata under its own key', () => {
    const reflector = new Reflector();
    expect(reflector.getClass(Audience, { getClass: () => Report })).toBe('internal');
    expect(getMetadata<string>(Region.KEY, Report, 'export')).toBe('eu');
    expect(getMetadata<string>(Audience.KEY, Report, 'export')).toBeUndefined();
  });
});
