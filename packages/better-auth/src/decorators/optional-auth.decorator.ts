import { Reflector } from '@velajs/vela';

export const OptionalAuth = Reflector.createDecorator<boolean>({ key: 'vela.auth.optional' });
export const OPTIONAL_AUTH_KEY = OptionalAuth.KEY;
