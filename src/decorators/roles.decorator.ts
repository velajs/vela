import { Reflector } from '@velajs/vela';

export const Roles = Reflector.createDecorator<string[]>({ key: 'vela.auth.roles' });
export const ROLES_KEY = Roles.KEY;
