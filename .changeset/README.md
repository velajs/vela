# Release notes

Run `pnpm changeset` from the repository root for public API changes. Run
`pnpm version-packages` to apply approved changesets and update the release plan.
The active release line is 1.x. Use minor changesets for breaking changes and
patch changesets for compatible fixes; backward compatibility is not required.
A patch may raise a peer range's floor to the release it ships with; use a minor
when the release would not work with a version its predecessor's peer ranges
accept.
Version preparation rejects any planned public version outside 1.x. Merging the
resulting version changes to main publishes the tested packages through GitHub
Actions OIDC with signed provenance.
