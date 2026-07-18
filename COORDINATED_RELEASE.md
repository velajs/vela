# Coordinated security release

The security hardening spans separately published packages. Publish in the
following phases so no consumer can resolve an older security contract or rely
on an unpublished sibling checkout.

1. Publish the independent foundations:
   `@velajs/errors@1.1.0`, `@velajs/live-protocol@1.1.0`,
   `@velajs/workflow@0.1.0`, `@velajs/ai@1.0.0`, and
   `@velajs/event-source@1.0.0`. Workflow may use any already-published
   compatible Errors 1.x while Errors 1.1 rolls out. Its initial 0.1.0 package
   has no version changeset, so dispatch Workflow's gated `Publish` workflow;
   it publishes the current version only when that version is absent.
2. Publish `@velajs/vela@1.21.0`. Its release preflight requires Live Protocol
   1.1 to be visible in the public registry.
3. Publish the Vela-only consumers: `@velajs/authz@1.1.0`,
   `@velajs/testing@1.0.0`, `@velajs/mail@1.0.0`, `@velajs/crud@1.20.0`
   with its coordinated adapter minors, `@velajs/cli@1.0.0`, and
   `@velajs/client@1.0.0` with the React and React Native 1.0 companions.
4. Publish the packages whose verification graph also uses Testing 1:
   `@velajs/feature-flags@1.0.0` and `@velajs/storage@1.0.0`.
5. Publish `@velajs/better-auth@1.0.0`,
   `@velajs/cloudflare-access@1.0.0`, and `@velajs/cloudflare@1.11.0`.
   These releases require their upstream Vela/Authz/Testing/Feature
   Flags/Mail/Workflow versions to be present first.
6. Publish `@velajs/agent@1.0.0` after AI 1, Mail 1, Workflow 0.1, and a
   compatible Errors 1.x are visible.

## Lockfile handoff between phases

Checked-in pre-release lockfiles must remain the last valid graph produced from
published registry metadata. A downstream lock may therefore be intentionally
out of date until its new upstream versions exist. It must never contain a
synthetic registry snapshot for an unpublished package, a guessed integrity
hash, or a relative/absolute `link:` override.

After each upstream phase is visible on npm, perform this handoff in every
downstream repository required by the next phase:

1. Use the repository's declared pnpm version (pnpm 11.11.0 for the
   coordinated downstream repositories) and regenerate from the registry:

   ```sh
   pnpm install --lockfile-only --no-frozen-lockfile
   ```

2. Validate that every registry snapshot has registry-issued resolution and
   integrity metadata and that no importer/override escapes to a sibling or
   machine-local link:

   ```sh
   node scripts/check-release-lock.mjs
   ```

3. Prove the committed result supports a clean install and the repository's
   complete verification suite, then reject high/critical advisories:

   ```sh
   pnpm install --frozen-lockfile
   pnpm release:check
   ```

   `release:check` reruns the lock integrity preflight, the repository-specific
   `verify` target (including its type checks, tests, and workerd suites where
   configured), and `pnpm audit --audit-level=high`.

4. Commit the regenerated `pnpm-lock.yaml` before triggering that repository's
   release workflow.

`ERR_PNPM_OUTDATED_LOCKFILE` before the upstream publication is an intentional
release gate. Do not bypass it by editing lock snapshots or temporarily linking
a sibling at publish time. `minimumReleaseAgeExclude` contains only the exact
coordinated versions so the supply-chain age policy does not delay this planned
handoff.
