import { ENV, Module } from '@velajs/vela';
import { CrudModule, defineCrudFeature } from '@velajs/crud';
import { acquireDatabase } from './database.js';
import { itemModel } from './schema.js';
@Module({
  imports: [
    CrudModule.forRequestAsync({
      inject: [ENV],
      useFactory: (lifetime, env) => acquireDatabase(env.HYPERDRIVE, lifetime),
    }),
    CrudModule.forFeature([
      defineCrudFeature({ path: '/items', model: itemModel, database: 'primary' }),
    ]),
  ],
})
export class AppModule {}
