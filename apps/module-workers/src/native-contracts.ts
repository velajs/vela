import { z } from 'zod';

// Synthetic opaque credentials belong only to this local example's verifier.
export const catalogInput = z
  .object({
    credential: z.string().optional(),
    tenantId: z.string().min(1),
    documentId: z.string().min(1),
  })
  .strict();
export type CatalogInput = z.infer<typeof catalogInput>;
export interface CatalogResult {
  subject: string;
  tenantId: string;
  documentId: string;
  frozen: boolean;
}
export interface CatalogBinding {
  read(input: CatalogInput): Promise<CatalogResult>;
}
export interface IdentityBinding {
  verify(credential: unknown): Promise<unknown>;
}
export interface MembershipBinding {
  admits(subject: string, tenantId: string): Promise<boolean>;
}
export const verifiedIdentity = z
  .object({
    principal: z
      .object({
        issuer: z.literal('example-accounts'),
        subject: z.string().min(1),
        principalType: z.literal('user'),
      })
      .strict(),
    expiresAtMs: z.number().int(),
    roles: z.array(z.string()),
    claims: z.object({ catalog: z.boolean() }).strict(),
  })
  .strict();
