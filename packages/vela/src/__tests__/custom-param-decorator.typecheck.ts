import { createLazyParamDecorator, createParamDecorator, ParseIntPipe } from '../index';

const Required = createParamDecorator((data: string) => data);
Required('x');
Required('x', ParseIntPipe);
// @ts-expect-error Required data cannot be omitted.
Required();
// @ts-expect-error Required data cannot be undefined.
Required(undefined);
// @ts-expect-error Caller cannot substitute another data type.
Required(1);

const Optional = createParamDecorator((data: string | undefined) => data);
Optional();
Optional(undefined, ParseIntPipe);
Optional('x');
const None = createParamDecorator((_data: undefined) => 1);
None();
// @ts-expect-error Undefined-only data excludes strings.
None('x');
createParamDecorator((_data: unknown) => 1)();

const LazyRequired = createLazyParamDecorator((data: string) => data);
LazyRequired('x');
// @ts-expect-error Lazy factories also require their declared data.
LazyRequired();
// @ts-expect-error Lazy factories also reject undefined for required data.
LazyRequired(undefined);
// @ts-expect-error Lazy decorators inject a function, so do not accept result pipes.
LazyRequired('x', ParseIntPipe);
const LazyOptional = createLazyParamDecorator((data: string | undefined) => data);
LazyOptional();
LazyOptional('x');
createLazyParamDecorator((_data: undefined) => Promise.resolve(1))();
