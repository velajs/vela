// `vela new` generates projects with exact framework pins. The pins track this
// workspace's versions, so a CLI release scaffolds projects against the
// framework packages released with it, never an older registry API.

/** The `vela new` templates shipped in the CLI package, each with its own manifest. */
export const starterTemplates = ['minimal', 'api'];

/** The starter manifests, one per template. */
export const starterManifests = starterTemplates.map(
  (template) => new URL(`../packages/cli/templates/${template}/package.json`, import.meta.url),
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
 * Before publication, the release's framework packages exist only as archives:
 * resolve every archive, so the starter's pins and their own framework
 * dependencies install from the release, and third-party packages from npm.
 * Without archives (a check after publication) everything comes from npm.
 */
export function starterArchiveOverrides(manifest, archives) {
  const names = Object.keys(archives);
  if (names.length === 0) return {};
  for (const field of fields) {
    for (const name of Object.keys(manifest[field] ?? {})) {
      if (name.startsWith('@velajs/') && !Object.hasOwn(archives, name))
        throw new Error(`The starter pins ${name}, but ${name} has no release archive`);
    }
  }
  return Object.fromEntries(names.toSorted().map((name) => [name, archives[name]]));
}
