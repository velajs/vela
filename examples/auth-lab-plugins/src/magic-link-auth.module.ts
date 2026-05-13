import { InjectionToken, Module } from '@velajs/vela';
import { magicLink } from 'better-auth/plugins';
import { EmailService } from './email.service.js';

// The plugin token is the public contract of this feature module. AppModule
// imports MagicLinkAuthModule and pulls MAGIC_LINK_PLUGIN into its forRootAsync
// inject list to compose the plugin into the betterAuth() instance.
//
// Note: typing here uses `unknown` because better-auth's plugin objects are
// runtime-shaped and not exported as a typed interface. The wiring is what
// matters; the betterAuth() factory at the call site does the final shape
// check.
export const MAGIC_LINK_PLUGIN = new InjectionToken<unknown>(
  'auth-lab.MagicLinkPlugin',
);

@Module({
  providers: [
    EmailService,
    {
      provide: MAGIC_LINK_PLUGIN,
      // The plugin's sendMagicLink callback is closed over a DI'd EmailService.
      // No global state, no top-level wiring — the plugin gets vela's full DI
      // graph at construction time.
      inject: [EmailService],
      useFactory: (email: EmailService) =>
        magicLink({
          sendMagicLink: (data) =>
            email.send({ email: data.email, url: data.url, token: data.token }),
        }),
    },
  ],
  exports: [MAGIC_LINK_PLUGIN, EmailService],
})
export class MagicLinkAuthModule {}
