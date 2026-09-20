# Release notes

Run `pnpm changeset` from the repository root for public API changes. Run
`pnpm version-packages` to apply approved changesets and update the release plan.
The active release line is 1.x. Merging the resulting version changes to main
publishes the tested packages through GitHub Actions OIDC with signed provenance.
