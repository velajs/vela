import { Injectable } from '@velajs/vela';

export interface SentLink {
  email: string;
  url: string;
  token: string;
  sentAt: Date;
}

// A toy email service that captures "sent" magic links in memory so the
// smoke test can assert the magicLink plugin's sendMagicLink callback fired.
// Real implementations would call SendGrid / Resend / SES here.
@Injectable()
export class EmailService {
  private readonly outbox: SentLink[] = [];

  send(data: { email: string; url: string; token: string }): void {
    this.outbox.push({
      email: data.email,
      url: data.url,
      token: data.token,
      sentAt: new Date(),
    });
    // eslint-disable-next-line no-console
    console.log(`[email] sent magic link to ${data.email} -> ${data.url}`);
  }

  outboxFor(email: string): SentLink[] {
    return this.outbox.filter((s) => s.email === email);
  }

  clear(): void {
    this.outbox.length = 0;
  }
}
