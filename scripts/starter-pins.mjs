// `vela new` generates projects with exact framework pins. The pins track this
// workspace's versions, so a CLI release scaffolds projects against the
// framework packages released with it, never an older registry API.

/** The starter manifest shipped in the CLI package. */
export const starterManifest = new URL(
  '../packages/cli/templates/worker/package.json',
  import.meta.url,
);

const fields = ['dependencies', 'devDependencies'];

/** Describe each starter pin of a workspace package that differs from its version. */
export function starterPinMismatches(manifest, versions) {
  return fields.flatMap((field) =>
    Object.entries(manifest[field] ?? {}).flatMap(([name, pin]) =>
      versions.has(name) && versions.get(name) !== pin
        ? [`${field}.${name} pins ${pin}, not the workspace version ${versions.get(name)}`]
        : [],
    ),
  );
}

/** Return the manifest with every workspace package pinned to its workspace version. */
export function syncStarterPins(manifest, versions) {
  const synced = { ...manifest };
  for (const field of fields) {
    if (!manifest[field]) continue;
    synced[field] = Object.fromEntries(
      Object.entries(manifest[field]).map(([name, pin]) => [name, versions.get(name) ?? pin]),
    );
  }
  return synced;
}

/**
 * Before publication, the pinned framework versions exist only as release
 * archives: install those from the archives and every other pin from npm.
 */
export function starterArchiveOverrides(manifest, archives) {
  return Object.fromEntries(
    fields
      .flatMap((field) => Object.keys(manifest[field] ?? {}))
      .filter((name) => Object.hasOwn(archives, name))
      .toSorted()
      .map((name) => [name, archives[name]]),
  );
}
