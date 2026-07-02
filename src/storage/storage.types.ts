/** A named storage disk backed by an R2 bucket binding. */
export interface DiskConfig {
  disk: string;
  /** R2Bucket binding name from wrangler.toml. */
  binding: string;
  /** Optional root prefix; supports path-template tokens ({date}/{year}/…). */
  root?: string;
}

export interface PresignedUrlConfig {
  defaultExpiry: number;
  maxExpiry: number;
}

export interface StorageModuleOptions {
  disks: DiskConfig[];
  defaultDisk: string;
  presignedUrl?: PresignedUrlConfig;
}
