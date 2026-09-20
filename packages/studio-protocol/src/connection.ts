/** Browser configuration emitted by the loopback host. Never contains the master token. */
export interface StudioConnection {
  protocolVersion: 2;
  routerBasePath: string;
  adminBasePath: string;
  apiRequestPath: string;
  sessionToken: string;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isLocalPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.startsWith('/') &&
    !value.startsWith('//') &&
    !/[\\\\?#\s]/.test(value)
  );
}

export function parseStudioConnection(value: unknown): StudioConnection {
  if (
    !isRecord(value) ||
    value.protocolVersion !== 2 ||
    !isLocalPath(value.routerBasePath) ||
    !isLocalPath(value.adminBasePath) ||
    !isLocalPath(value.apiRequestPath) ||
    typeof value.sessionToken !== 'string' ||
    value.sessionToken.length === 0
  ) {
    throw new Error('Invalid Studio connection configuration.');
  }
  return {
    protocolVersion: value.protocolVersion,
    routerBasePath: value.routerBasePath,
    adminBasePath: value.adminBasePath,
    apiRequestPath: value.apiRequestPath,
    sessionToken: value.sessionToken,
  };
}
