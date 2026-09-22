# Release notes

Run `pnpm changeset` from the repository root for public API changes. Run
`pnpm version-packages` to apply approved changesets and update the release plan.
The active release line is 1.x. Use minor changesets for breaking changes and
patch changesets for compatible fixes; backward compatibility is not required.
Version preparation rejects any planned public version outside 1.x. Merging the
resulting version changes to main publishes the tested packages through GitHub
Actions OIDC with signed provenance.
