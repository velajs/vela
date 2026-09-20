import { InjectionToken } from '@velajs/vela';
import { betterAuth } from 'better-auth';
import { admin } from 'better-auth/plugins';
import { describe, expectTypeOf, it } from 'vitest';
import { BetterAuthModule, BetterAuthService, type BetterAuthInstance } from '../index';

const auth = betterAuth({
  baseURL: 'https://test.invalid',
  secret: 'unit-test-only-secret-at-least-32-characters',
  plugins: [admin()],
  user: { additionalFields: { department: { type: 'string', required: false } } },
});

describe('Better Auth public type contracts', () => {
  it('retains the concrete plugin API through the service without widening to any', () => {
    const service = new BetterAuthService(() => auth);
    expectTypeOf(service.auth).toEqualTypeOf<typeof auth>();
    expectTypeOf(service.api).toEqualTypeOf<typeof auth.api>();
    expectTypeOf(service.api.listUsers).toEqualTypeOf<typeof auth.api.listUsers>();
    expectTypeOf(auth).toExtend<BetterAuthInstance>();
    BetterAuthModule.forRoot({ auth });
  });

  it('infers async factory arguments from its injection tokens', () => {
    const SECRET = new InjectionToken<string>('auth-test-secret');
    BetterAuthModule.forRootAsync({
      inject: [SECRET],
      useFactory: (secret) => {
        expectTypeOf(secret).toEqualTypeOf<string>();
        return betterAuth({ secret });
      },
    });
  });

  it('requires runtime injection evidence even with an explicit tuple generic', () => {
    const SECRET = new InjectionToken<string>('auth-test-required-secret');
    const invalidRegistration = () => {
      // @ts-expect-error a generic annotation cannot stand in for an actual inject tuple.
      BetterAuthModule.forRootAsync<readonly [typeof SECRET]>({
        useFactory: (secret) => betterAuth({ secret }),
      });
    };
    // Compile-only rejection fixture; never execute the invalid registration.
    expectTypeOf(invalidRegistration).toBeFunction();
  });
});
