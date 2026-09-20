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
 * `getBooleanValue(key)`; when the flag is off it throws `NotFoundException`
 * (the route appears hidden) or `ForbiddenException` per the decorator option.
 * Handlers with no `@FeatureFlag()` metadata pass through untouched, so the
 * guard is safe to register app-wide (`FeatureFlagsModule.forRoot({ isGlobal:
 * true })`) or per-route via `@UseGuards(FeatureFlagGuard)`.
 *
 * It does NOT inject `REQUEST_CONTEXT` — that would make the guard request-
 * scoped and break lazy-module materialization (which constructs every provider
 * once, at first use, possibly outside a request). Instead it reads the request
 * context off the per-request child container carried on the Hono context, so
 * the module's `context` resolver still runs for the gate decision.
 */
@Injectable()
export class FeatureFlagGuard implements CanActivate {
  private readonly reflector = new Reflector();

  constructor(@Inject(FEATURE_FLAG_TOKENS.Service) private readonly flags: FeatureFlagsService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const meta = this.reflector.getAllAndOverride<FeatureFlagMetadata>(
      FEATURE_FLAG_METADATA,
      context,
    );
    if (!meta) return true;

    const requestContext = this.requestContext(context);
    const flags = requestContext ? this.flags.forRequest(requestContext) : this.flags;
    const enabled = await flags.getBooleanValue(meta.key);
    if (enabled) return true;

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
