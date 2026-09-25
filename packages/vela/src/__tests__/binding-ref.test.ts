import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  ENV,
  Injectable,
  Inject,
  Module,
  VelaFactory,
  defineProvider,
  type VelaEnv,
} from '../index.js';
import {
  Container,
  defineBinding,
  readEnv,
  resolveBinding,
  type Binding,
  type BindingKind,
  type BindingRef,
  type EnvFactory,
} from '../module-kit.js';

interface Counter {
  increment(): number;
}

const counterKind: BindingKind<Counter> = {
  name: 'counter',
  configKey: 'counters',
  accepts: (value): value is Counter =>
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'increment') === 'function',
};

function counter(start = 0): Counter {
  let value = start;
  return { increment: () => ++value };
}

describe('BindingRef', () => {
  it('resolves a named binding from an environment and validates its shape', () => {
    const native = counter();
    const env = { COUNTER: native };
    expect(resolveBinding(env, { binding: 'COUNTER' }, counterKind)).toBe(native);
  });

  it('names the binding and the configuration key when the binding is missing', () => {
    expect(() => resolveBinding({}, { binding: 'COUNTER' }, counterKind)).toThrow(
      "ENV.COUNTER is not set: declare the counter binding 'COUNTER' under counters",
    );
  });

  it('rejects a value of the wrong kind with the configuration key to fix', () => {
    expect(() => resolveBinding({ COUNTER: 'text' }, { binding: 'COUNTER' }, counterKind)).toThrow(
      "ENV.COUNTER is not a binding of type counter: declare 'COUNTER' under counters",
    );
  });

  it('rejects an absent environment and malformed references', () => {
    expect(() => resolveBinding(undefined, { binding: 'COUNTER' }, counterKind)).toThrow(
      "The counter binding 'COUNTER' needs the application ENV",
    );
    const counters = defineBinding(counterKind);
    expect(() => counters({ binding: '' })).toThrow('non-empty');
    expect(() => counters({ binding: 'a b' })).toThrow('binding name');
  });

  it('builds lower-camel binding factories that resolve per environment, never at declaration', () => {
    const counters = defineBinding(counterKind);
    const ref = counters({ binding: 'COUNTER' });
    expectTypeOf(ref).toEqualTypeOf<Binding<Counter>>();
    expectTypeOf(ref).toMatchTypeOf<EnvFactory<Counter>>();
    expectTypeOf(ref).toMatchTypeOf<BindingRef>();
    expect(ref.binding).toBe('COUNTER');
    expect(ref.kind).toBe(counterKind);

    const first = counter(10);
    const second = counter(20);
    expect(ref({ COUNTER: first })).toBe(first);
    expect(ref({ COUNTER: second })).toBe(second);
    expect(() => ref({})).toThrow("ENV.COUNTER is not set: declare the counter binding 'COUNTER'");
  });

  it('keeps each application on its own ENV when module options hold a binding factory', async () => {
    const TOKEN = Symbol('counter');
    const counters = defineBinding(counterKind);
    const configured = counters({ binding: 'COUNTER' });

    @Injectable()
    class Reader {
      constructor(@Inject(TOKEN) readonly counter: Counter) {}
    }

    @Module({
      providers: [
        defineProvider(TOKEN, {
          useFactory: (container: Container) => configured(readEnv(container)),
          inject: [Container],
        }),
        Reader,
      ],
    })
    class AppModule {}

    const a = await VelaFactory.create(AppModule, { env: { COUNTER: counter(100) } });
    const b = await VelaFactory.create(AppModule, { env: { COUNTER: counter(200) } });
    expect(a.get(Reader).counter.increment()).toBe(101);
    expect(b.get(Reader).counter.increment()).toBe(201);
    expect(a.get(ENV)).not.toBe(b.get(ENV));
  });

  it('reads an empty environment when no runtime seeded ENV', async () => {
    @Module({})
    class Empty {}
    const app = await VelaFactory.create(Empty);
    const env: VelaEnv = readEnv(app.getContainer());
    expect(Object.keys(env)).toEqual([]);
    expect(() => defineBinding(counterKind)({ binding: 'COUNTER' })(env)).toThrow(
      "ENV.COUNTER is not set: declare the counter binding 'COUNTER' under counters",
    );
  });
});
