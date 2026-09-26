import { Module, InjectionToken, defineProvider } from '@velajs/vela';
import { defineCloudflareApp } from '@velajs/cloudflare';
import { VelaWorkflowDefinition } from '@velajs/cloudflare/workflow-definitions';
import { defineWorkflow } from '@velajs/workflow';
import { z } from 'zod';

const DEFINITION = new InjectionToken<ReturnType<typeof definitionFactory>>('example-definition');
function definitionFactory() {
  return defineWorkflow<{ count: number }, number>({
    handler: (context) => context.step.do('count', async () => context.params.count),
  });
}
class AppModule {}
Module({ providers: [defineProvider(DEFINITION, { useFactory: definitionFactory })] })(AppModule);
const app = defineCloudflareApp(AppModule);

export class ExampleWorkflow extends VelaWorkflowDefinition(app, {
  params: z.object({ count: z.string().transform(Number) }),
  inject: [DEFINITION],
  useFactory: (definition) => ({
    definition,
    // No dispatch operations exist in this workflow; applications wire their own dispatcher.
    run: async () => {
      throw new Error('No dispatch targets configured');
    },
  }),
}) {}

type Payload = Parameters<InstanceType<typeof ExampleWorkflow>['run']>[0]['payload'];
const valid: Payload = { count: '3' };
// @ts-expect-error native trigger payload uses schema input, not its transformed output
const invalid: Payload = { count: 3 };
void [valid, invalid];

export default { fetch: () => Response.json({ ok: true }) };
