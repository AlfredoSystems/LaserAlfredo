/** A finished, controller-specific job ready to leave the app. */
export interface JobPayload {
  /** File name including extension, e.g. `job.rd`. */
  readonly fileName: string;
  readonly bytes: Uint8Array;
}

/**
 * Where encoded jobs go. Every kind of machine I/O sits behind this
 * interface; nothing else in the app talks to hardware or the file system.
 */
export interface Transport {
  readonly name: string;
  send(payload: JobPayload): Promise<void>;
}

/** Keeps only characters that are safe in a file name on a FAT-formatted USB stick. */
export function safeFileName(name: string, extension: string): string {
  const base = name
    .trim()
    .replace(/\.[^.]*$/, '')
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32);
  return `${base || 'job'}.${extension}`;
}
