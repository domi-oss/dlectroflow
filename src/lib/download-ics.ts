import { downloadBlob } from "./download-file";

/** Trigger a client-side .ics download from raw calendar text. Imported only
 *  by client components (touches the DOM). */
export function downloadIcs(ics: string, filename: string): void {
  downloadBlob(
    new Blob([ics], { type: "text/calendar;charset=utf-8" }),
    filename,
  );
}
