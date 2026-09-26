import { InjectionToken, type ExecutionLifetime } from '@velajs/vela';
import { acquireCrudDatabases, createCrudDatabaseRegistry, CrudModule } from '@velajs/crud';
const environment = new InjectionToken<{ endpoint: string }>('request-database-environment');
CrudModule.forRequestAsync({
  inject: [environment],
  useFactory: (lifetime, env) => {
    const typedLifetime: ExecutionLifetime = lifetime;
    const endpoint: string = env.endpoint;
    return acquireCrudDatabases({
      signal: typedLifetime.signal,
      acquire: () => ({ endpoint }),
      create: (handle) => {
        const exact: string = handle.endpoint;
        void exact;
        return createCrudDatabaseRegistry([]);
      },
      release: (handle) => {
        const exact: string = handle.endpoint;
        void exact;
      },
    });
  },
});
CrudModule.forRequestAsync({
  useFactory: (lifetime) =>
    acquireCrudDatabases({
      signal: lifetime.signal,
      acquire: () => ({}),
      create: () => createCrudDatabaseRegistry([]),
      release() {},
    }),
});
