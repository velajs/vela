/** A named storage disk backed by an R2 bucket binding. */
export interface DiskConfig {
  disk: string;
  /** Native bucket supplied by a typed environment provider factory. */
  bucket: R2Bucket;
  /** Optional root prefix; supports path-template tokens ({date}/{year}/…). */
  root?: string;
}

export interface PresignedUrlConfig {
  defaultExpiry: number;
  maxExpiry: number;
}

export interface StorageModuleOptions {
  /** HMAC secret used for signed downloads. */
  secret?: string;
  disks: DiskConfig[];
  defaultDisk: string;
  presignedUrl?: PresignedUrlConfig;
}
