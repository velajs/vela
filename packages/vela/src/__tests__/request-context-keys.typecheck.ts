import { RequestContextKey, type RequestContext } from '../http/request-context';

const LOCALE = new RequestContextKey<string>('locale');
const COUNT = new RequestContextKey<number>('count');
const UNION = new RequestContextKey<string | number>('union');

export function verifyRequestContextKeys(context: RequestContext): void {
  context.set(LOCALE, 'en');
  context.set(COUNT, 4);
  const locale: string | undefined = context.get(LOCALE);
  const count: number | undefined = context.get(COUNT);
  const raw: unknown = context.get('raw');
  context.set('raw', { unvalidated: true });
  context.set(Symbol.for('raw'), 42);
  context.has(LOCALE);
  context.has('raw');
  void [locale, count, raw];

  // @ts-expect-error Raw keys carry no value-type evidence.
  context.get<string>('raw');
  // @ts-expect-error A token determines the result; callers cannot choose another type.
  context.get<number>(LOCALE);
  // @ts-expect-error Values must match the token, not widen its type through inference.
  context.set(LOCALE, 42);
  // @ts-expect-error Explicit unknown cannot widen a number key to admit a string write.
  context.set<unknown>(COUNT, 'bad');
  // @ts-expect-error Explicit unions cannot widen a key to admit unrelated values either.
  context.set<string | number>(COUNT, 'bad');
  // @ts-expect-error An unvalidated raw value is not known to be a string.
  const unvalidated: string = context.get('raw');
  // @ts-expect-error Keys are invariant; widening must not permit writes of unrelated values.
  const widened: RequestContextKey<string | number> = LOCALE;
  // @ts-expect-error Unknown widening must not erase the key's write contract.
  const unknownKey: RequestContextKey<unknown> = COUNT;
  // @ts-expect-error Narrowing a token must not change the type of values already stored under it.
  const narrowed: RequestContextKey<string> = UNION;
  void [unvalidated, widened, unknownKey, narrowed];
}
