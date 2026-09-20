import { defineProvider, InjectionToken, Module } from '@velajs/vela';
import { magicLink } from 'better-auth/plugins';
import { EmailService } from './email.service.js';

// The plugin token is the public contract of this feature module. AppModule
// imports MagicLinkAuthModule and pulls MAGIC_LINK_PLUGIN into its forRootAsync
// inject list to compose the plugin into the betterAuth() instance.
//
export const MAGIC_LINK_PLUGIN = new InjectionToken<ReturnType<typeof magicLink>>(
  'auth-lab.MagicLinkPlugin',
);

@Module({
  providers: [
    EmailService,
    defineProvider(MAGIC_LINK_PLUGIN, {
      // The plugin's sendMagicLink callback is closed over a DI'd EmailService.
      // No global state, no top-level wiring — the plugin gets vela's full DI
      // graph at construction time.
      inject: [EmailService],
      useFactory: (email: EmailService) =>
        magicLink({
          sendMagicLink: (data) =>
            email.send({ email: data.email, url: data.url, token: data.token }),
        }),
    }),
  ],
  exports: [MAGIC_LINK_PLUGIN, EmailService],
})
export class MagicLinkAuthModule {}
