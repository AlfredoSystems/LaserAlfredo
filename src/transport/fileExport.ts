import type { JobPayload, Transport } from './transport';

/**
 * Saves the job as a file download, to be copied to a USB stick and run from
 * the controller panel. Sends nothing to the machine.
 */
export class FileExport implements Transport {
  readonly name = 'File export';

  send(payload: JobPayload): Promise<void> {
    // Copy into a fresh buffer so the Blob never aliases a transferred or shared one.
    const blob = new Blob([new Uint8Array(payload.bytes)], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = payload.fileName;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return Promise.resolve();
  }
}
