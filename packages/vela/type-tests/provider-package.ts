// Intentionally imports the package export. Source-only tests cannot detect
// variance annotations lost during declaration emission or bundling.
import {
  Container,
  ConfigurableModuleBuilder,
  EntrypointRegistry,
  InjectionToken,
  Module,
  defineModule,
  defineProvider,
  lazyProvider,
  type Token,
  type TypedToken,
} from '@velajs/vela';

const count = new InjectionToken<number>('count');
const label = new InjectionToken<string>('label');
const container = new Container();
const entrypoints = new EntrypointRegistry();
// @ts-expect-error Metadata shape requires decoder evidence in the emitted API.
entrypoints.ofKind<{ count: number }>('count');
// @ts-expect-error A caller cannot fabricate a builder state through constructor generics.
new ConfigurableModuleBuilder<{ count: number }, 'register'>();
const originalBuilder = new ConfigurableModuleBuilder<{ count: number }>();
const renamedBuilder = originalBuilder.setClassMethodName('register');
originalBuilder.build().ConfigurableModuleClass.forRoot({ count: 1 });
renamedBuilder.build().ConfigurableModuleClass.register({ count: 1 });
// @ts-expect-error The older builder alias keeps its original method name.
originalBuilder.build().ConfigurableModuleClass.register({ count: 1 });
container.register(defineProvider(count, { useValue: 1 }));
container.register(
  defineProvider(label, {
    inject: [count],
    useFactory: (value) => value.toFixed(0),
  }),
);
const result: number = container.resolve(count);
void result;

// @ts-expect-error Emitted declarations must keep the invariant function type.
const widened: InjectionToken<unknown> = count;
// @ts-expect-error A caller cannot supply a result generic instead of a token type.
defineProvider<unknown>(count, { useValue: 'bad' });
// @ts-expect-error An explicit wide token argument cannot erase numeric identity.
defineProvider<InjectionToken<unknown>>(count, { useValue: 'bad' });
// @ts-expect-error The typed-token union preserves invariance too.
defineProvider<TypedToken<unknown>>(count, { useValue: 'bad' });
// @ts-expect-error Erased registry identity has no authoring capability.
defineProvider<Token>(count, { useValue: 'bad' });
const erased: Token = count;
// @ts-expect-error An erased variable likewise cannot be rebound.
defineProvider(erased, { useValue: 'bad' });
// @ts-expect-error Request cache writes cannot use an erased generic.
container.setRequestInstance<Token>(count, 'bad');
// A literal whose value matches its token is a provider.
Module({ providers: [{ provide: count, useValue: 1 }] });
// @ts-expect-error A literal's value must match its token.
Module({ providers: [{ provide: count, useValue: 'bad' }] });
// @ts-expect-error Runtime injection tokens cannot be replaced by a generic tuple.
defineProvider<typeof label, readonly [typeof count]>(label, {
  useFactory: (value) => value.toFixed(),
});
// @ts-expect-error The lazy helper preserves the same runtime injection requirement.
lazyProvider<string, readonly [typeof count]>({
  provide: new InjectionToken<() => string>('lazy'),
  useFactory: (value) => value.toFixed(),
});
const { ConfigurableModuleClass } = defineModule<{ value: number }>({ name: 'Public' });
// @ts-expect-error Generated module declaration also requires actual runtime dependencies.
ConfigurableModuleClass.forRootAsync<readonly [typeof count]>({
  useFactory: (value: number) => ({ value }),
});
// @ts-expect-error Raw keys resolve to unknown from the emitted package API.
const invented: number = container.resolve('raw');
void [widened, invented];
