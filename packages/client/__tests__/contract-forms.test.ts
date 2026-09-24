import { describe, expect, it } from 'vitest';
import { Body, Controller, Module, Post, VelaFactory } from '@velajs/vela';
import {
  contractFormEncodings,
  defineRoute,
  type ContractApp,
  type ContractBody,
} from '@velajs/vela/contract';
import type { StandardSchemaV1 } from '@velajs/vela/validation';
import { hc, withFormEncoding } from '../src/http';

interface Signup {
  email: string;
  plan: string;
}

const SignupForm: StandardSchemaV1<Signup, Signup> = {
  '~standard': {
    version: 1,
    vendor: 'test',
    validate(value) {
      if (
        typeof value === 'object' &&
        value !== null &&
        'email' in value &&
        typeof value.email === 'string' &&
        'plan' in value &&
        typeof value.plan === 'string'
      )
        return { value: { email: value.email, plan: value.plan } };
      return { issues: [{ message: 'email and plan are required' }] };
    },
  },
};

const signup = defineRoute({ method: 'POST', path: '/signups', body: SignupForm, form: {} });
const routes = [signup] as const;

@Controller('/signups')
class Signups {
  @Post(signup)
  create(@Body() body: ContractBody<typeof signup>) {
    return { email: body.email, plan: body.plan };
  }
}

describe('URL-encoded contracts through ContractApp', () => {
  it('sends a form: contract URL-encoded with the encodings its contracts list', async () => {
    @Module({ controllers: [Signups] })
    class App {}
    const app = await VelaFactory.create(App);
    const transport = async (input: RequestInfo | URL, init?: RequestInit) =>
      app.fetch(new Request(input, init));
    try {
      const plain = hc<ContractApp<typeof routes>>('https://example.test', { fetch: transport });
      // hc sends every form input as multipart, which a form: route refuses.
      const refused = await plain.signups.$post({ form: { email: 'a@example.test', plan: 'pro' } });
      expect(refused.status).toBe(415);

      const client = hc<ContractApp<typeof routes>>('https://example.test', {
        fetch: withFormEncoding(contractFormEncodings(routes), transport),
      });
      const created = await client.signups.$post({
        form: { email: 'a@example.test', plan: 'pro' },
      });
      expect(created.status).toBe(201);
      expect(await created.json()).toEqual({ email: 'a@example.test', plan: 'pro' });
    } finally {
      await app.close();
    }
  });
});
