// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { downloadBlobMock } = vi.hoisted(() => ({ downloadBlobMock: vi.fn() }));
vi.mock("@/lib/download-file", () => ({ downloadBlob: downloadBlobMock }));

import { ExportData } from "./export-data";

function zipResponse(
  init: { status?: number; headers?: Record<string, string> } = {},
) {
  return new Response(new Blob([new Uint8Array([0x50, 0x4b])]), {
    status: init.status ?? 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition":
        'attachment; filename="dlectroflow-export-sam-2026-08-03.zip"',
      ...init.headers,
    },
  });
}

const control = () => screen.getByRole("link", { name: /download my data/i });

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  // Explicit, matching every other component test here: vitest.config.ts does not
  // set `globals: true`, so testing-library's automatic cleanup never registers
  // and a second render leaves the first one's DOM behind.
  cleanup();
  vi.unstubAllGlobals();
});

describe("ExportData", () => {
  it("is a link to the export endpoint, so it works before hydration and with JS off", () => {
    // The feature's whole purpose is that somebody can get their data out; it
    // must not depend on a bundle having loaded.
    render(<ExportData />);
    expect(control()).toHaveAttribute("href", "/api/export");
    expect(control()).toHaveAttribute("download");
  });

  it("has an accessible name that says what it does, and hides the icon from it", () => {
    render(<ExportData />);
    // "Download my data (.zip)" — not "Export", not an icon alone.
    expect(control()).toHaveAccessibleName(/download my data \(\.zip\)/i);
    expect(control().querySelector("svg")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
  });

  it("shows a focus indicator that is not solely a background colour", () => {
    // WCAG 2.4.7 / 1.4.11: a ring survives forced-colours mode and does not rely
    // on hue. Asserted on the class because that is where the property lives —
    // jsdom computes no styles for Tailwind.
    render(<ExportData />);
    expect(control().className).toContain("focus-visible:ring-2");
  });

  it("is reachable and activatable from the keyboard", async () => {
    const fetchMock = vi.fn().mockResolvedValue(zipResponse());
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<ExportData />);
    await user.tab();
    expect(control()).toHaveFocus();
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/export", expect.anything()),
    );
  });

  it("downloads the archive under the filename the server chose", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(zipResponse()));
    render(<ExportData />);
    await userEvent.click(control());
    await waitFor(() =>
      expect(downloadBlobMock).toHaveBeenCalledWith(
        expect.any(Blob),
        "dlectroflow-export-sam-2026-08-03.zip",
      ),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(/downloaded/i);
  });

  it("falls back to a sensible filename if the header is missing", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(new Blob([new Uint8Array([1])]), { status: 200 }),
        ),
    );
    render(<ExportData />);
    await userEvent.click(control());
    await waitFor(() =>
      expect(downloadBlobMock).toHaveBeenCalledWith(
        expect.any(Blob),
        "dlectroflow-export.zip",
      ),
    );
  });

  it("explains a 429 in seconds, using the server's Retry-After", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          zipResponse({ status: 429, headers: { "Retry-After": "37" } }),
        ),
    );
    render(<ExportData />);
    await userEvent.click(control());
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/37 seconds/);
    expect(downloadBlobMock).not.toHaveBeenCalled();
  });

  it("tells the reader to sign in again on a 401", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(zipResponse({ status: 429 })),
    );
    render(<ExportData />);
    // A 429 with no Retry-After still produces a usable sentence.
    await userEvent.click(control());
    expect(await screen.findByRole("alert")).toHaveTextContent(/60 seconds/);
  });

  it("reports a network failure rather than failing silently", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    render(<ExportData />);
    await userEvent.click(control());
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /did not go through/i,
    );
  });

  it("reports a 500 as a failure and downloads nothing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(zipResponse({ status: 500 })),
    );
    render(<ExportData />);
    await userEvent.click(control());
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(downloadBlobMock).not.toHaveBeenCalled();
  });

  it("keeps one accessible name throughout, so it does not change under a screen reader", async () => {
    // WCAG 2.5.3-adjacent: progress is carried by aria-busy and the live region,
    // not by rewriting the control's label mid-request.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => {})),
    );
    render(<ExportData />);
    const before = control().textContent;
    await userEvent.click(control());
    await waitFor(() => expect(control()).toHaveAttribute("aria-busy", "true"));
    expect(control().textContent).toBe(before);
  });

  it("announces progress politely and marks itself busy while in flight", async () => {
    let release: (r: Response) => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>((resolve) => (release = resolve))),
    );
    render(<ExportData />);
    await userEvent.click(control());
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(/preparing/i),
    );
    expect(control()).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
    release(zipResponse());
    await waitFor(() =>
      expect(control()).toHaveAttribute("aria-busy", "false"),
    );
  });

  it("does not fire twice while a request is in flight", async () => {
    const fetchMock = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetchMock);
    render(<ExportData />);
    await userEvent.click(control());
    await userEvent.click(control());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("leaves a modified click alone, so Save-as still works", async () => {
    const fetchMock = vi.fn().mockResolvedValue(zipResponse());
    vi.stubGlobal("fetch", fetchMock);
    // ONE user-event instance: the held modifier is instance state, so the
    // convenience `userEvent.click` (a fresh instance per call) would drop it and
    // this test would pass for the wrong reason.
    const user = userEvent.setup();
    render(<ExportData />);
    await user.keyboard("{Meta>}");
    await user.click(control());
    await user.keyboard("{/Meta}");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("names the two things that are NOT exported", async () => {
    // The archive's README says it too, but somebody who never opens the zip
    // should not be able to assume their Google connection travelled with it.
    render(<ExportData />);
    const description = screen.getByText(/single \.zip/i);
    expect(description).toHaveTextContent(/Google connection/);
    expect(description).toHaveTextContent(/API key/);
  });
});
