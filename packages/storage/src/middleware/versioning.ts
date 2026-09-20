import { StorageError } from '../storage.error';
import type { StorageDriver } from '../storage.types';
import { passthrough, type Middleware } from './wrap';

export interface VersionInfo {
  versionId: string;
  key: string;
  size: number;
  lastModified?: number;
}

/** Extra surface a versioning-wrapped driver exposes (reached via {@link unwrapVersioning}). */
export interface Versioned {
  listVersions(key: string): Promise<VersionInfo[]>;
  restore(key: string, versionId: string): Promise<void>;
  deleteVersion(key: string, versionId: string): Promise<void>;
}

export const VERSIONED: unique symbol = Symbol.for('vela.storage.versioned');

export interface VersioningOptions {
  /** Prefix under which prior versions are stored. Default `.vela-versions/`. */
  prefix?: string;
  versionId?: () => string;
  /** Keep at most this many versions per key (prunes oldest). */
  maxVersions?: number;
  /** Hide the version prefix from `list()`. Default true. */
  hideFromList?: boolean;
  /** On delete: snapshot first (default) or purge all versions. */
  onDelete?: 'snapshot' | 'purge';
}

/**
 * Keeps prior versions on overwrite via key-suffixing (no external manifest →
 * no read-modify-write race). Snapshots are cheap when the base driver
 * `supportsServerSideCopy`. Direct presigned uploads bypass snapshotting, so
 * `signedUploadUrl` throws. Reach `listVersions`/`restore`/`deleteVersion` via
 * {@link unwrapVersioning}.
 */
export function versioning(opts: VersioningOptions = {}): Middleware {
  const prefix = opts.prefix ?? '.vela-versions/';
  let seq = 0;
  const vid = opts.versionId ?? (() => `${Date.now().toString(36)}-${(seq++).toString(36)}`);
  const vkey = (key: string, id: string) => `${prefix}${key}/${id}`;
  const isVersion = (key: string) => key.startsWith(prefix);

  const listVersions = async (inner: StorageDriver, key: string): Promise<VersionInfo[]> => {
    const res = await inner.list({ prefix: `${prefix}${key}/` });
    return res.items.map((item) => ({
      versionId: item.key.slice(item.key.lastIndexOf('/') + 1),
      key: item.key,
      size: item.size,
      lastModified: item.lastModified,
    }));
  };

  const snapshot = async (inner: StorageDriver, key: string): Promise<void> => {
    if (!(await inner.exists(key))) return;
    const id = vid();
    if (inner.supportsServerSideCopy) {
      await inner.copy(key, vkey(key, id));
    } else {
      const current = await inner.download(key);
      await inner.upload(vkey(key, id), current.stream(), { contentType: current.type });
    }
    if (opts.maxVersions) {
      const versions = (await listVersions(inner, key)).sort((a, b) =>
        a.versionId < b.versionId ? -1 : 1,
      );
      for (const v of versions.slice(0, Math.max(0, versions.length - opts.maxVersions))) {
        await inner.delete(v.key);
      }
    }
  };

  return (inner) => {
    const driver = passthrough(inner, {
      async upload(k, b, o) {
        await snapshot(inner, k);
        return inner.upload(k, b, o);
      },
      async copy(f, t, o) {
        await snapshot(inner, t);
        return inner.copy(f, t, o);
      },
      async delete(k, o) {
        if (opts.onDelete !== 'purge') await snapshot(inner, k);
        await inner.delete(k, o);
        if (opts.onDelete === 'purge') {
          for (const v of await listVersions(inner, k)) await inner.delete(v.key);
        }
      },
      list:
        opts.hideFromList === false
          ? undefined
          : async (o) => {
              const res = await inner.list(o);
              return {
                items: res.items.filter((i) => !isVersion(i.key)),
                prefixes: res.prefixes?.filter((p) => !isVersion(p)),
                cursor: res.cursor,
              };
            },
      signedUploadUrl() {
        throw new StorageError('Unsupported', 'versioning: direct uploads bypass snapshots');
      },
    });

    const versioned: Versioned = {
      listVersions: (key) => listVersions(inner, key),
      async restore(key, versionId) {
        await snapshot(inner, key);
        await inner.copy(vkey(key, versionId), key);
      },
      deleteVersion: (key, versionId) => inner.delete(vkey(key, versionId)),
    };

    return Object.assign(driver, { [VERSIONED]: versioned });
  };
}

/** Retrieve the {@link Versioned} surface from a versioning-wrapped driver (or `undefined`). */
export function unwrapVersioning(driver: StorageDriver): Versioned | undefined {
  return (driver as unknown as { [VERSIONED]?: Versioned })[VERSIONED];
}
