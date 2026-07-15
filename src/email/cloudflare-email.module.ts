import type { DynamicModule } from '@velajs/vela';
import { MAIL_TRANSPORT } from '@velajs/mail';
import type { MailTransport } from '@velajs/mail';
import { BindingRef } from '../binding-ref';
import { SEND_EMAIL_BINDING_REF } from '../tokens';
import { createCloudflareEmailTransport } from './cloudflare-email-transport';

/** Options for {@link CloudflareEmailModule.forRoot}. */
export interface CloudflareEmailModuleOptions {
  /**
   * Name of the wrangler `send_email` binding to send over. Must match the
   * `name` in the wrangler `send_email` array. Defaults to `'SEND_EMAIL'`.
   */
  binding?: string;
}

/** Default `send_email` binding name. */
export const DEFAULT_SEND_EMAIL_BINDING = 'SEND_EMAIL';

/**
 * Provides an outbound `@velajs/mail` transport backed by a Cloudflare
 * `send_email` binding. Import it BEFORE `MailModule.forRoot({ from })` — it
 * contributes {@link MAIL_TRANSPORT} as a GLOBAL token, so `MailService`
 * (declared in the separate `MailModule`, which does not import this one)
 * resolves the transport across module boundaries. `MailModule` uses the
 * transport whenever no explicit `transport` is passed to its own `forRoot`.
 *
 * ```ts
 * @Module({
 *   imports: [
 *     CloudflareEmailModule.forRoot(),          // provides MAIL_TRANSPORT
 *     MailModule.forRoot({ from: 'no-reply@example.com' }),
 *   ],
 * })
 * export class AppModule {}
 * ```
 *
 * The binding ref is auto-initialized by `createCloudflareApp`'s request
 * middleware (it is a registered `useValue`, collected exactly like every other
 * `BindingRef`); the transport reads it lazily at delivery time.
 */
export class CloudflareEmailModule {
  static forRoot(options: CloudflareEmailModuleOptions = {}): DynamicModule {
    const bindingName = options.binding ?? DEFAULT_SEND_EMAIL_BINDING;
    // One ref instance, shared between the DI registration (so the adapter
    // initializes it) and the transport closure (so it reads the same value).
    const ref = new BindingRef<SendEmail>(bindingName);

    return {
      module: CloudflareEmailModule,
      // Dedup by binding name, mirroring the createBindingModule convention: two
      // forRoot() for the same binding collapse; distinct bindings coexist.
      key: bindingName,
      providers: [
        { provide: SEND_EMAIL_BINDING_REF, useValue: ref },
        {
          provide: MAIL_TRANSPORT,
          useFactory: (): MailTransport => createCloudflareEmailTransport(ref),
        },
      ],
      // Globalize ONLY the transport token so the mailer in another module can
      // resolve it (a dynamic module's `global: true` globalizes all exports, so
      // the binding ref is deliberately left unexported).
      exports: [MAIL_TRANSPORT],
      global: true,
    };
  }
}
