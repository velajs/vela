import { expect, it } from 'vitest';
import {
  defineProvider,
  Inject,
  Injectable,
  InjectionToken,
  Module,
  Scope,
  VelaFactory,
} from '../../index';
import {
  createDiscoverableDecorator,
  DiscoveryService,
  registerEntrypointKind,
} from '../../module-kit';

it('preserves keyed module ownership and lazy metadata in the Workers runtime', async () => {
  const Marker = createDiscoverableDecorator<{ queue: string }>('workers:owned:module');
  registerEntrypointKind({ kind: 'workers:owned', metaKey: Marker.KEY, level: 'class' });
  const NAME = new InjectionToken<string>('workers module name');
  @Marker({ queue: 'jobs' })
  @Injectable({ scope: Scope.REQUEST })
  class Consumer {
    readonly #name: string;
    constructor(@Inject(NAME) name: string) {
      this.#name = name;
    }
    name() {
      return this.#name;
    }
  }
  class Feature {}
  @Module({
    imports: ['one', 'two'].map((key) => ({
      module: Feature,
      key,
      lazy: true,
      providers: [defineProvider(NAME, { useValue: key }), Consumer],
    })),
  })
  class Root {}
  const app = await VelaFactory.create(Root);
  const hits = app.get(DiscoveryService).registrationsWithMeta(Marker, { metadataOnly: true });
  expect(hits.map((hit) => hit.moduleId)).toEqual(['Feature#one', 'Feature#two']);
  expect(hits.every((hit) => hit.instance === undefined)).toBe(true);
  const scope = app.getContainer().createChild();
  try {
    const values = await Promise.all(
      app.entrypoints
        .ofKind('workers:owned')
        .map((entry) => scope.resolveAsync(Consumer, entry.moduleId)),
    );
    expect(values.map((value) => value.name())).toEqual(['one', 'two']);
  } finally {
    await scope.dispose();
    await app.close();
  }
});
