export type TenantStatus = 'active' | 'suspended';
export interface TenantRecord {
  readonly id: string;
  readonly name: string;
  readonly status: TenantStatus;
  readonly revision: number;
  readonly settings: Readonly<Record<string, unknown>>;
}
export interface TenantPrincipal {
  readonly issuer: string;
  readonly subject: string;
  readonly principalType: 'user' | 'service';
  readonly expiresAtMs?: number;
}
export interface TenantLookup {
  get(id: string): Promise<TenantRecord | null>;
}
export interface TenantAuditEvent {
  readonly id: string;
  readonly tenantId: string;
  readonly action: 'create' | 'update' | 'administration';
  readonly principal: TenantPrincipal;
  readonly reason: string;
  readonly at: number;
}
export interface TenantRegistryStore extends TenantLookup {
  list(options?: { after?: string; limit?: number }): Promise<readonly TenantRecord[]>;
  /** Compare-and-set and audit append MUST commit atomically. */
  put(
    record: TenantRecord,
    expectedRevision: number | null,
    event: TenantAuditEvent,
  ): Promise<boolean>;
  appendAudit(event: TenantAuditEvent): Promise<void>;
}
export interface TenantSnapshot extends TenantRecord {
  readonly authority: 'tenant' | 'targeted-administration';
  readonly source: string;
  readonly principal: TenantPrincipal;
}
export interface TenantContextReader {
  current(): TenantSnapshot | undefined;
  requireTenant(): TenantSnapshot;
  requireTenantId(): string;
  requireTenantTarget(): TenantSnapshot;
}
export class TenantError extends Error {
  constructor(
    readonly code:
      | 'INVALID_TENANT'
      | 'TENANT_REQUIRED'
      | 'TENANT_DENIED'
      | 'TENANT_CONFLICT'
      | 'TENANT_UNAVAILABLE',
    message = code,
  ) {
    super(message);
    this.name = 'TenantError';
  }
}
export function tenantId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.trim() !== value ||
    new TextEncoder().encode(value).length > 256 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new TenantError('INVALID_TENANT');
  }
  return value.normalize('NFC');
}
function jsonSnapshot(value: unknown, depth = 0): unknown {
  if (depth > 32) throw new TypeError('Tenant settings are too deep');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return Object.freeze(value.map((v) => jsonSnapshot(v, depth + 1)));
  if (
    typeof value !== 'object' ||
    value === null ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw new TypeError('Tenant settings must be JSON');
  return Object.freeze(
    Object.fromEntries(
      Object.keys(value).map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !('value' in descriptor))
          throw new TypeError('Tenant settings cannot contain accessors');
        return [key, jsonSnapshot(descriptor.value, depth + 1)];
      }),
    ),
  );
}
export function parseTenant(value: unknown): TenantRecord {
  if (
    !value ||
    typeof value !== 'object' ||
    !('id' in value) ||
    !('name' in value) ||
    !('status' in value) ||
    !('revision' in value) ||
    !('settings' in value) ||
    typeof value.name !== 'string' ||
    (value.status !== 'active' && value.status !== 'suspended') ||
    typeof value.revision !== 'number' ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1
  ) {
    throw new TypeError('Invalid tenant record');
  }
  const settings = jsonSnapshot(value.settings);
  if (!settings || typeof settings !== 'object' || Array.isArray(settings))
    throw new TypeError('Tenant settings must be a record');
  return Object.freeze({
    id: tenantId(value.id),
    name: value.name,
    status: value.status,
    revision: value.revision,
    settings: Object.freeze(Object.fromEntries(Object.entries(settings))),
  });
}
function principalSnapshot(principal: TenantPrincipal): TenantPrincipal {
  const issuer = tenantId(principal.issuer),
    subject = tenantId(principal.subject);
  if (principal.principalType !== 'user' && principal.principalType !== 'service')
    throw new TenantError('TENANT_DENIED');
  if (
    principal.expiresAtMs !== undefined &&
    (!Number.isSafeInteger(principal.expiresAtMs) || principal.expiresAtMs <= Date.now())
  )
    throw new TenantError('TENANT_DENIED');
  return Object.freeze({
    issuer,
    subject,
    principalType: principal.principalType,
    ...(principal.expiresAtMs === undefined ? {} : { expiresAtMs: principal.expiresAtMs }),
  });
}

/** Scope objects are application-owned capabilities, never ambient singleton state. */
class OperationTenantScope implements TenantContextReader {
  #active = true;
  constructor(private readonly snapshot: TenantSnapshot) {}
  close(): void {
    this.#active = false;
  }
  current(): TenantSnapshot | undefined {
    return this.#active &&
      (this.snapshot.principal.expiresAtMs === undefined ||
        this.snapshot.principal.expiresAtMs > Date.now())
      ? this.snapshot
      : undefined;
  }
  requireTenantTarget(): TenantSnapshot {
    const current = this.current();
    if (!current) throw new TenantError('TENANT_REQUIRED');
    return current;
  }
  requireTenant(): TenantSnapshot {
    const current = this.requireTenantTarget();
    if (current.authority !== 'tenant') throw new TenantError('TENANT_DENIED');
    return current;
  }
  requireTenantId(): string {
    return this.requireTenant().id;
  }
}
export interface TenantServiceOptions {
  lookup: TenantLookup;
  /** Membership/service authorization is mandatory, including background work. */
  authorize(input: {
    tenant: TenantRecord;
    principal: TenantPrincipal;
    source: string;
  }): boolean | Promise<boolean>;
}
export interface TenantRunOptions {
  tenantId: string;
  principal: TenantPrincipal;
  source?: string;
  parent?: TenantContextReader;
}
export class TenantService {
  constructor(private readonly options: TenantServiceOptions) {}
  async admit(options: TenantRunOptions): Promise<TenantSnapshot> {
    const id = tenantId(options.tenantId),
      principal = principalSnapshot(options.principal);
    const parent = options.parent?.requireTenant();
    if (
      parent &&
      (parent.id !== id ||
        parent.principal.issuer !== principal.issuer ||
        parent.principal.subject !== principal.subject ||
        parent.principal.principalType !== principal.principalType)
    )
      throw new TenantError('TENANT_CONFLICT');
    // No positive cache: a new admission always checks the authoritative store.
    const found = await this.options.lookup.get(id);
    if (!found) throw new TenantError('TENANT_DENIED');
    const tenant = parseTenant(found);
    if (tenant.id !== id || tenant.status !== 'active') throw new TenantError('TENANT_DENIED');
    const source = options.source ?? 'programmatic';
    if ((await this.options.authorize({ tenant, principal, source })) !== true)
      throw new TenantError('TENANT_DENIED');
    // Reject an authority revision that changed while membership was being checked.
    const latest = await this.options.lookup.get(id);
    if (!latest || parseTenant(latest).revision !== tenant.revision || latest.status !== 'active')
      throw new TenantError('TENANT_DENIED');
    principalSnapshot(principal);
    return Object.freeze({ ...tenant, principal, source, authority: 'tenant' });
  }
  async run<Result>(
    options: TenantRunOptions,
    work: (scope: TenantContextReader) => Result | Promise<Result>,
  ): Promise<Result> {
    const scope = new OperationTenantScope(await this.admit(options));
    try {
      return await work(scope);
    } finally {
      scope.close();
    }
  }
}
export interface TenantAdministrationOptions {
  store: TenantRegistryStore;
  authorize(input: {
    principal: TenantPrincipal;
    tenantId: string;
    action: TenantAuditEvent['action'];
    reason: string;
  }): boolean | Promise<boolean>;
}
export class TenantRegistry {
  constructor(private readonly options: TenantAdministrationOptions) {}
  async #event(
    id: string,
    action: TenantAuditEvent['action'],
    principal: TenantPrincipal,
    reason: string,
  ): Promise<TenantAuditEvent> {
    principal = principalSnapshot(principal);
    if (!reason.trim() || reason.length > 512 || /[\u0000-\u001f\u007f]/.test(reason))
      throw new TenantError('TENANT_DENIED');
    if ((await this.options.authorize({ principal, tenantId: id, action, reason })) !== true)
      throw new TenantError('TENANT_DENIED');
    principalSnapshot(principal);
    return Object.freeze({
      id: crypto.randomUUID(),
      tenantId: id,
      action,
      principal,
      reason,
      at: Date.now(),
    });
  }
  async save(
    input: Omit<TenantRecord, 'revision'>,
    expectedRevision: number | null,
    principal: TenantPrincipal,
    reason: string,
  ): Promise<TenantRecord> {
    if (
      expectedRevision !== null &&
      (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)
    )
      throw new TypeError('Invalid expected tenant revision');
    const record = parseTenant({ ...input, revision: (expectedRevision ?? 0) + 1 });
    const event = await this.#event(
      record.id,
      expectedRevision === null ? 'create' : 'update',
      principal,
      reason,
    );
    if (!(await this.options.store.put(record, expectedRevision, event)))
      throw new TenantError('TENANT_CONFLICT');
    return record;
  }
  async runForTenant<Result>(
    id: string,
    principal: TenantPrincipal,
    reason: string,
    work: (scope: TenantContextReader) => Result | Promise<Result>,
  ): Promise<Result> {
    id = tenantId(id);
    const record = await this.options.store.get(id);
    if (!record || parseTenant(record).id !== id) throw new TenantError('TENANT_DENIED');
    const event = await this.#event(id, 'administration', principal, reason);
    await this.options.store.appendAudit(event);
    const scope = new OperationTenantScope(
      Object.freeze({
        ...parseTenant(record),
        principal: event.principal,
        source: 'administration',
        authority: 'targeted-administration',
      }),
    );
    try {
      return await work(scope);
    } finally {
      scope.close();
    }
  }
}

export class MemoryTenantRegistryStore implements TenantRegistryStore {
  readonly #records = new Map<string, TenantRecord>();
  readonly #events: TenantAuditEvent[] = [];
  constructor(records: readonly TenantRecord[] = []) {
    for (const row of records) {
      const parsed = parseTenant(row);
      this.#records.set(parsed.id, parsed);
    }
  }
  async get(id: string): Promise<TenantRecord | null> {
    return this.#records.get(tenantId(id)) ?? null;
  }
  async list({ after = '', limit = 100 }: { after?: string; limit?: number } = {}): Promise<
    readonly TenantRecord[]
  > {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
      throw new TypeError('Invalid directory limit');
    return [...this.#records.values()]
      .filter((r) => r.id > after)
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .slice(0, limit);
  }
  async put(
    record: TenantRecord,
    expected: number | null,
    event: TenantAuditEvent,
  ): Promise<boolean> {
    const parsed = parseTenant(record);
    if (event.tenantId !== parsed.id) throw new TypeError('Conflicting audit target');
    if (
      (this.#records.get(parsed.id)?.revision ?? null) !== expected ||
      parsed.revision !== (expected ?? 0) + 1
    )
      return false;
    const audit = Object.freeze(structuredClone(event));
    this.#records.set(parsed.id, parsed);
    this.#events.push(audit);
    return true;
  }
  async appendAudit(event: TenantAuditEvent): Promise<void> {
    this.#events.push(Object.freeze(structuredClone(event)));
  }
  audit(): readonly TenantAuditEvent[] {
    return structuredClone(this.#events);
  }
}

export type TenantSelector = (request: Request) => string | undefined;
/** Adapter for @velajs/crud/multi-tenant. The resolver must verify authentication. */
export function tenantAdmission(
  service: TenantService,
  principal: (
    request: Request,
  ) => TenantPrincipal | undefined | Promise<TenantPrincipal | undefined>,
): {
  admit(selector: string, request: Request): Promise<TenantSnapshot>;
} {
  return {
    async admit(selector, request) {
      const identity = await principal(request);
      if (!identity) throw new TenantError('TENANT_DENIED');
      return service.admit({ tenantId: selector, principal: identity, source: 'http' });
    },
  };
}
export const headerTenant =
  (name = 'x-tenant-id'): TenantSelector =>
  (request) =>
    request.headers.get(name) ?? undefined;
export const queryTenant =
  (name = 'tenantId'): TenantSelector =>
  (request) => {
    const values = new URL(request.url).searchParams.getAll(name);
    if (values.length > 1) throw new TenantError('INVALID_TENANT');
    return values[0];
  };
export const hostTenant =
  (baseDomain: string): TenantSelector =>
  (request) => {
    const host = new URL(request.url).hostname.toLowerCase();
    const suffix = `.${baseDomain.toLowerCase()}`;
    return host.endsWith(suffix) ? host.slice(0, -suffix.length) : undefined;
  };
