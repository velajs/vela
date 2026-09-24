import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  REQUEST_CONTEXT,
  Reflector,
  type CanActivate,
  type ExecutionContext,
  type RequestContext,
} from '@velajs/vela';
import {
  FEATURE_FLAG_METADATA,
  type FeatureFlagMetadata,
} from '../decorators/feature-flag.decorator';
import type { FeatureFlagsService } from '../feature-flags.service';
import { FEATURE_FLAG_TOKENS } from '../feature-flags.tokens';

/**
 * Route gate for `@FeatureFlag()`. Reads the handler/controller metadata, then
 * `getBooleanDetails(key)`; only an explicit `true` without an evaluation
 * error opens the route. Disabled, malformed, or failed evaluations throw
 * `NotFoundException` (route hidden) or `ForbiddenException` per the decorator.
 * Handlers with no `@FeatureFlag()` metadata pass through untouched, so
 * `FeatureFlagsModule` registers the guard app-wide by default; with
 * `globalGuard: false`, apply it per route via `@UseGuards(FeatureFlagGuard)`.
 *
 * It does NOT inject `REQUEST_CONTEXT` — that would make the guard request-
 * scoped and break lazy-module materialization (which constructs every provider
 * once, at first use, possibly outside a request). Instead it reads the request
 * context off the per-request child container carried on the Hono context, so
 * the module's `context` resolver still runs for the gate decision.
 */
@Injectable()
export class FeatureFlagGuard implements CanActivate {
  constructor(
    @Inject(FEATURE_FLAG_TOKENS.Service) private readonly flags: FeatureFlagsService,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const meta = this.reflector.getAllAndOverride<FeatureFlagMetadata>(
      FEATURE_FLAG_METADATA,
      context,
    );
    if (!meta) return true;

    const requestContext = this.requestContext(context);
    if (!requestContext) return this.deny(meta);
    const details = await this.flags.forRequest(requestContext).getBooleanDetails(meta.key, false);
    if (details.reason !== 'ERROR' && details.value === true) return true;

    return this.deny(meta);
  }

  private deny(meta: FeatureFlagMetadata): never {
    if (meta.onDisabled === 'forbidden') {
      throw new ForbiddenException(`Feature "${meta.key}" is not enabled.`);
    }
    throw new NotFoundException();
  }

  /** The current request context, via the child container on the Hono context. */
  private requestContext(context: ExecutionContext): RequestContext | undefined {
    try {
      const container = context.getContainer();
      return container?.resolve(REQUEST_CONTEXT);
    } catch {
      return undefined;
    }
  }
}
