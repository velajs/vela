import type { Session, User } from './better-auth.types';

export interface SessionData {
  readonly user: User;
  readonly session: Session;
  readonly roles: readonly string[];
  readonly tenantId?: string;
}

function own(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

function requiredString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function date(value: unknown): Date | undefined {
  return value instanceof Date && Number.isFinite(value.getTime()) ? new Date(value) : undefined;
}

function optionalString(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || typeof value === 'string';
}

/** Keep plugin data opaque; base model fields below are validated individually. */
function dataProperties(value: object): Record<string, unknown> {
  return Object.fromEntries(Object.keys(value).map((key) => [key, own(value, key)]));
}

/** Validate the full Better Auth base models, not merely ids masquerading as them. */
export function validateSessionData(value: unknown): SessionData | undefined {
  try {
    const user = own(value, 'user');
    const session = own(value, 'session');
    if (
      typeof user !== 'object' ||
      user === null ||
      typeof session !== 'object' ||
      session === null
    ) {
      return undefined;
    }
    const id = own(user, 'id');
    const email = own(user, 'email');
    const name = own(user, 'name');
    const emailVerified = own(user, 'emailVerified');
    const image = own(user, 'image');
    const createdAt = date(own(user, 'createdAt'));
    const updatedAt = date(own(user, 'updatedAt'));
    const sessionId = own(session, 'id');
    const userId = own(session, 'userId');
    const token = own(session, 'token');
    const sessionCreatedAt = date(own(session, 'createdAt'));
    const sessionUpdatedAt = date(own(session, 'updatedAt'));
    const expiresAt = date(own(session, 'expiresAt'));
    const ipAddress = own(session, 'ipAddress');
    const userAgent = own(session, 'userAgent');
    const organization = own(session, 'activeOrganizationId');
    const role = own(user, 'role');
    let roles: string[] = [];
    if (role !== undefined && role !== null) {
      if (typeof role === 'string')
        roles = role
          .split(',')
          .map((part) => part.trim())
          .filter(Boolean);
      else if (
        Array.isArray(role) &&
        role.every((entry: unknown): entry is string => typeof entry === 'string')
      ) {
        roles = role.map((entry: string) => entry.trim()).filter(Boolean);
      } else return undefined;
    }
    if (
      !requiredString(id) ||
      !requiredString(email) ||
      typeof name !== 'string' ||
      typeof emailVerified !== 'boolean' ||
      !optionalString(image) ||
      !createdAt ||
      !updatedAt ||
      !requiredString(sessionId) ||
      userId !== id ||
      !requiredString(token) ||
      !sessionCreatedAt ||
      !sessionUpdatedAt ||
      !expiresAt ||
      expiresAt.getTime() <= Date.now() ||
      !optionalString(ipAddress) ||
      !optionalString(userAgent) ||
      (organization !== undefined && organization !== null && !requiredString(organization))
    )
      return undefined;
    return {
      user: Object.freeze({
        ...dataProperties(user),
        id,
        email,
        name,
        emailVerified,
        createdAt,
        updatedAt,
        image,
      }),
      session: Object.freeze({
        ...dataProperties(session),
        id: sessionId,
        userId: id,
        token,
        createdAt: sessionCreatedAt,
        updatedAt: sessionUpdatedAt,
        expiresAt,
        ipAddress,
        userAgent,
      }),
      roles: Object.freeze(roles),
      ...(typeof organization === 'string' ? { tenantId: organization } : {}),
    };
  } catch {
    return undefined;
  }
}
