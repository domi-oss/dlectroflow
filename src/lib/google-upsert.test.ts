import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { upsertGoogleTask } from "./google";

const TOKEN = "tok";
const LIST = "list_1";
const body = {
  title: "[1/2] do the thing",
  notes: "note",
  due: "2026-07-31T10:00:00.000Z",
};

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const ok = (json: unknown) =>
  ({
    ok: true,
    status: 200,
    json: async () => json,
    text: async () => "",
  }) as unknown as Response;
const fail = (status: number) =>
  ({
    ok: false,
    status,
    json: async () => ({}),
    text: async () => "err",
  }) as unknown as Response;

describe("upsertGoogleTask", () => {
  it("POSTs and reports created when there is no existing id", async () => {
    fetchMock.mockResolvedValueOnce(ok({ id: "new_1" }));
    await expect(upsertGoogleTask(TOKEN, LIST, null, body)).resolves.toEqual({
      id: "new_1",
      created: true,
    });
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "POST" });
  });

  it("PATCHes the existing task instead of creating a second one", async () => {
    fetchMock.mockResolvedValueOnce(ok({ id: "old_1" }));
    await expect(upsertGoogleTask(TOKEN, LIST, "old_1", body)).resolves.toEqual(
      {
        id: "old_1",
        created: false,
      },
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "PATCH" });
    expect(fetchMock.mock.calls[0][0]).toContain("old_1");
  });

  it("sends title, notes AND due on the PATCH — a moved deadline is the point", () => {
    fetchMock.mockResolvedValueOnce(ok({ id: "old_1" }));
    return upsertGoogleTask(TOKEN, LIST, "old_1", body).then(() => {
      const sent = JSON.parse(String(fetchMock.mock.calls[0][1].body));
      expect(sent).toMatchObject({
        title: body.title,
        notes: body.notes,
        due: body.due,
      });
    });
  });

  it("re-creates when the task was deleted in Google (404)", async () => {
    fetchMock
      .mockResolvedValueOnce(fail(404))
      .mockResolvedValueOnce(ok({ id: "new_2" }));
    await expect(upsertGoogleTask(TOKEN, LIST, "gone", body)).resolves.toEqual({
      id: "new_2",
      created: true,
    });
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: "POST" });
  });

  it("throws on a non-404 failure rather than silently losing the schedule", async () => {
    fetchMock.mockResolvedValueOnce(fail(500));
    await expect(upsertGoogleTask(TOKEN, LIST, "old_1", body)).rejects.toThrow(
      /500/,
    );
  });

  it("omits due entirely when the encoder did not supply one", async () => {
    fetchMock.mockResolvedValueOnce(ok({ id: "new_3" }));
    await upsertGoogleTask(TOKEN, LIST, null, { title: "t", notes: "n" });
    expect(
      JSON.parse(String(fetchMock.mock.calls[0][1].body)),
    ).not.toHaveProperty("due");
  });
});
