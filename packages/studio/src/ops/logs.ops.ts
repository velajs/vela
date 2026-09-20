/**
 * Observability ops backed by the M2 in-memory rings: `logs.tail` over
 * {@link AdminLogBuffer} and `audit.tail` over {@link AdminAuditLog}. Both are
 * read ops; args carry the optional level filter / limit.
 */
import { Inject, Injectable } from '@velajs/vela';
import type { AdminAuditEntry, AdminLogEntry, StudioOpReq } from '@velajs/studio-protocol';
import { AdminRpc } from '../rpc/admin-rpc.decorator';
import type { AdminOpContext } from '../studio.types';
import { AdminLogBuffer } from '../logs/log-buffer';
import { AdminAuditLog } from '../audit/audit-log';

@Injectable()
export class StudioLogsOps {
  constructor(
    @Inject(AdminLogBuffer) private readonly logs: AdminLogBuffer,
    @Inject(AdminAuditLog) private readonly audit: AdminAuditLog,
  ) {}

  @AdminRpc({ op: 'logs.tail' })
  tail(_ctx: AdminOpContext, args: StudioOpReq<'logs.tail'>): AdminLogEntry[] {
    return this.logs.tail(args ?? {});
  }

  @AdminRpc({ op: 'audit.tail' })
  auditTail(_ctx: AdminOpContext, args: StudioOpReq<'audit.tail'>): AdminAuditEntry[] {
    return this.audit.tail((args ?? {}).limit);
  }
}
