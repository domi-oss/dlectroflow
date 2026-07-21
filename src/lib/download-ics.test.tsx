// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { downloadIcs } from "./download-ics";

afterEach(() => vi.restoreAllMocks());

describe("downloadIcs", () => {
  it("creates a blob URL and clicks an anchor with the given filename, then revokes", () => {
    const createURL = vi.fn(() => "blob:xyz");
    const revokeURL = vi.fn();
    (URL as unknown as { createObjectURL: unknown }).createObjectURL =
      createURL;
    (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL =
      revokeURL;
    let downloadedName = "";
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) {
        downloadedName = this.download;
      });

    downloadIcs("BEGIN:VCALENDAR", "dlectroflow-plan.ics");

    expect(createURL).toHaveBeenCalledOnce();
    expect(clickSpy).toHaveBeenCalledOnce();
    expect(downloadedName).toBe("dlectroflow-plan.ics");
    expect(revokeURL).toHaveBeenCalledWith("blob:xyz");
  });
});
