/** Vela deliberately permits breaking changes within its active 1.x line. */
export function assertV1Releases(packages) {
  for (const { name, version } of packages) {
    if (!/^1\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version ?? ''))
      throw new Error(
        `${name}@${version}: Vela stays on 1.x; use a minor changeset for breaking changes.`,
      );
  }
}
