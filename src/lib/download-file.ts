/**
 * Trigger a client-side download of a Blob. Imported only by client components
 * (touches the DOM).
 *
 * Extracted from `download-ics.ts` for #129: the data export downloads a zip
 * built by the server rather than text built in the browser, and there is no
 * reason for two copies of the create-URL / click / revoke dance — the revoke in
 * particular is the step that gets forgotten, and forgetting it pins the whole
 * blob in memory for the life of the document.
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
