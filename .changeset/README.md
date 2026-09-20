# Release notes

Run `pnpm changeset` from the repository root for public API changes. Run
`pnpm version-packages` to apply approved changesets and update the release plan.
The initial 2.0 migration notes were consumed and archived in
`docs/migration/2.0-changesets/`. The active release line is 1.x. Prepare versions
with `pnpm version-packages`; merging the resulting version changes to main
publishes the tested packages through GitHub Actions OIDC.
