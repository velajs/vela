import type { Session, User } from '../better-auth.types';

/** Complete network-free Better Auth base models plus validated plugin fields. */
export function sessionFixture(id = 'u-1', role = 'editor') {
  return {
    user: {
      id,
      name: 'Ada',
      email: 'ada@example.com',
      emailVerified: true,
      createdAt: new Date('2025-01-01'),
      updatedAt: new Date('2025-01-01'),
      role,
    } satisfies User & { role: string },
    session: {
      id: `session-${id}`,
      userId: id,
      token: `token-${id}`,
      createdAt: new Date('2025-01-01'),
      updatedAt: new Date('2025-01-01'),
      expiresAt: new Date('2099-01-01'),
      activeOrganizationId: 'tenant-1',
    } satisfies Session & { activeOrganizationId: string },
  };
}
