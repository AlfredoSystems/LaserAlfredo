/** Options shared by every importer. */
export interface ImportOptions {
  /** Endpoints closer than this are joined into one path. Default 0.01 mm. */
  readonly joinToleranceMm?: number;
  /** Maximum deviation when curves are turned into line segments. Default 0.02 mm. */
  readonly flattenToleranceMm?: number;
}
