import {
  cloudflareEmailTransport,
  type CloudflareEmailBinding,
  type CloudflareEmailPayload,
} from '@velajs/mail/transports/cloudflare';

// Compile against the installed native Workers overloads, not an invented binding cast.
export function nativeCompatibility(binding: SendEmail, payload: CloudflareEmailPayload) {
  const structural: CloudflareEmailBinding = binding;
  const native: EmailMessageBuilder = payload;
  void binding.send(native);
  return cloudflareEmailTransport({ binding: structural });
}

export function rejectLegacyBinding(binding: { send(message: EmailMessage): Promise<void> }) {
  // @ts-expect-error The old raw-MIME-only contract cannot send structured messages.
  cloudflareEmailTransport({ binding });
}
