import type { IdentityBinding, MembershipBinding } from './native-contracts';

const identity = (env: Cloudflare.Env): IdentityBinding => env.IDENTITY;
const membership = (env: Cloudflare.Env): MembershipBinding => env.MEMBERSHIP;
void [identity, membership];
