// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { hydrateRoot } from "react-dom/client";
import { InboxView } from "@/components/inbox/inbox-view";
import type { Item } from "@/components/inbox/bucket";
import type { AgingSettings } from "@/lib/aging";

// #105 — the inbox used to drop dark mode, and this is the file that keeps it
// from happening again.
//
// The chain: `formatAgo()` has SECOND granularity under a minute, and InboxView
// seeded its live clock during render (`useState(() => Date.now())`). The server
// evaluated that at request time and the browser evaluated it again at hydration
// time, so any row younger than a minute rendered "Ns ago" from two different
// seconds. React resolves a TEXT mismatch (minified error #418) by throwing the
// server tree away and re-rendering from the ROOT — which rebuilds <html>'s
// class list from the RSC payload, and the payload never carries the `dark` the
// pre-hydration <head> script wrote. A returning dark-mode user watched the
// theme fall off. Same fault, same fix as #75 on /settings: stamp it on the
// server, hand it down as a prop.
//
// The bug report needed CPU throttling to widen the server↔client gap until it
// straddled a second boundary — 0/6 reloads kept dark mode at 20x. That is a
// probability, not a test. Here both clocks are stubbed explicitly (one value
// for the server pass, a later one for hydration), so the mismatch is
// reproduced on every run on any machine. The throttled Playwright measurement
// in e2e/smoke/inbox-hydration.spec.ts is corroboration on a real build, not
// the proof.

const push = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh }),
}));

vi.mock("@/app/actions/braindump", () => ({
  createBrainDumpItem: vi.fn().mockResolvedValue(undefined),
  triageBrainDumpItem: vi.fn().mockResolvedValue(undefined),
  snoozeBrainDumpItem: vi.fn().mockResolvedValue(undefined),
  deleteBrainDumpItem: vi.fn().mockResolvedValue(undefined),
  keepAsTask: vi.fn().mockResolvedValue(undefined),
  markReminded: vi.fn().mockResolvedValue(undefined),
  freshenItem: vi.fn().mockResolvedValue(undefined),
  dismissPrompt: vi.fn().mockResolvedValue(undefined),
  completeItem: vi.fn().mockResolvedValue(undefined),
  reopenItem: vi.fn().mockResolvedValue(undefined),
  moveToReview: vi.fn().mockResolvedValue(undefined),
  requestBreakdown: vi.fn().mockResolvedValue(undefined),
  ensureFocusStep: vi.fn().mockResolvedValue(null),
  renameItem: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/app/actions/breakdown", () => ({
  startBreakdown: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/app/actions/settings", () => ({
  dismissWelcome: vi.fn().mockResolvedValue(undefined),
  updateVoice: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/app/actions/google-schedule", () => ({
  pushStepsToGoogleTasks: vi
    .fn()
    .mockResolvedValue({ ok: true, scheduled: 1, listTitle: "Reclaim" }),
  scheduleSingleTask: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock("@/app/actions/ics-schedule", () => ({
  scheduleViaIcs: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock("@/lib/download-ics", () => ({ downloadIcs: vi.fn() }));

vi.mock("@/lib/notifications", () => ({
  notificationPermission: () => "default",
  subscribeNotificationPermission: () => () => {},
  requestNotificationPermission: vi.fn().mockResolvedValue("default"),
  registerServiceWorker: vi.fn().mockResolvedValue(null),
  showReminder: vi.fn().mockResolvedValue(undefined),
}));

const settings: AgingSettings = {
  agingThresholdMinutes: 30,
  demoOverrideSeconds: null,
  agingHours: 24,
  overdueHours: 48,
  wayOverdueHours: 72,
};

/** A fixed wall clock, so "N seconds ago" is a fact and not a race. */
const SERVER_NOW = new Date("2026-07-29T12:00:12.000Z").getTime();
/** Hydration happens a beat later — on a throttled device, a whole second later. */
const CLIENT_NOW = SERVER_NOW + 1_400;

function makeItem(overrides: Partial<Item> = {}): Item {
  return {
    id: "item-1",
    text: "sample item",
    // 12s before the server's render: firmly inside formatAgo's `Ns` band, and
    // 13s by the time the client hydrates. That one digit is the whole bug.
    createdAt: new Date(SERVER_NOW - 12_000),
    status: "inbox",
    triagedAt: null,
    remindedAt: null,
    snoozedUntil: null,
    taskId: null,
    freshenedAt: null,
    promptDismissedAt: null,
    breakdownRequestedAt: null,
    stepsTotal: 0,
    stepsDone: 0,
    taskStatus: null,
    completedAt: null,
    scheduledAt: null,
    estMinutes: null,
    steps: [],
    ...overrides,
  };
}

function view(items: Item[], s: AgingSettings = settings) {
  return (
    <InboxView
      workspaceId="ws-test"
      initialItems={items}
      settings={s}
      welcomeVisible={false}
      resumeStep={null}
      // What the server stamped. Passed to BOTH renders, exactly as the RSC
      // payload does: the point is that the client render must not consult the
      // wall clock, which has moved on by the time it runs.
      now={SERVER_NOW}
    />
  );
}

/** The wall clock the component must not read while rendering. */
let clock = SERVER_NOW;
let nowSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  clock = SERVER_NOW;
  nowSpy = vi.spyOn(Date, "now").mockImplementation(() => clock);
});

afterEach(() => {
  cleanup();
  nowSpy.mockRestore();
  document.body.innerHTML = "";
});

/**
 * Server-render at the server's clock, then hydrate with the clock advanced —
 * the sequence a real page load performs across two processes. Returns the
 * recoverable errors React reported plus a handle on a server-rendered DOM node,
 * so a caller can tell "React patched something" from "React threw the tree
 * away and rebuilt it", which is the distinction that decides whether `dark`
 * survives.
 */
async function serverThenHydrate(items: Item[], s: AgingSettings = settings) {
  clock = SERVER_NOW;
  const html = renderToString(view(items, s));

  const container = document.createElement("div");
  // Trusted input: this is the string our own renderToString just produced.
  container.innerHTML = html;
  document.body.appendChild(container);

  // A node React created during the SERVER pass. If hydration bails out, React
  // deletes the server-rendered children and client-renders replacements, so
  // this handle goes stale — the same regeneration that resets <html>'s class.
  const serverRow = container.querySelector('[data-bucket="needsReview"] li');

  clock = CLIENT_NOW;
  const recoverable: string[] = [];
  await act(async () => {
    hydrateRoot(container, view(items, s), {
      onRecoverableError: (error: unknown) => {
        recoverable.push(
          error instanceof Error ? error.message : String(error),
        );
      },
    });
  });

  return { html, container, serverRow, recoverable };
}

describe("#105 the inbox hydrates a sub-minute row from one clock", () => {
  it("does not bail out of hydration when the wall clock moves between render and hydration", async () => {
    const { html, container, serverRow, recoverable } = await serverThenHydrate(
      [makeItem()],
    );

    // Precondition: the server really did render a second-granularity age. If
    // this ever stops being true the rest of the test proves nothing.
    expect(html).toContain("12s ago");

    // The assertion the bug fails: React error #418 arrives through
    // onRecoverableError ("server rendered text didn't match"). Note this is
    // asserted as EMPTY even though `/` has a known, separate hydration
    // mismatch — dnd-kit's `aria-describedby` id (#94). That one is an
    // ATTRIBUTE mismatch, which React reports as a console warning and does not
    // recover from by regenerating; see the test below that pins the difference.
    expect(recoverable).toEqual([]);

    // …and the mechanism, asserted directly: the server's DOM node is still the
    // one on the page. A regeneration would have detached it, and it is that
    // regeneration — not the wrong label — that rebuilds <html>'s className and
    // strips `dark`.
    expect(serverRow).not.toBeNull();
    expect(serverRow!.isConnected).toBe(true);
    expect(container.contains(serverRow!)).toBe(true);

    // The label the user is left looking at is the server's, unchanged, until
    // the interval ticks. Pinning the FIRST render is all the fix does.
    expect(container.textContent).toContain("12s ago");
    expect(container.textContent).not.toContain("13s ago");
  });

  it("reads no wall clock at all while rendering", async () => {
    // The root cause in one assertion. `renderToString` runs the render pass and
    // no effects, so every Date.now() counted here happened DURING render — and
    // anything read during render is a value the server and the client each roll
    // for themselves. The live interval still calls Date.now(); that is an
    // effect, and effects never run on the server.
    const before = nowSpy.mock.calls.length;
    renderToString(view([makeItem()]));
    expect(nowSpy.mock.calls.length - before).toBe(0);
  });

  it("renders identically twice even as the wall clock advances between the two renders", async () => {
    // Same props ⇒ same markup: the DoD's "pin the initial clock". Two
    // independent renders stand in for the two processes, with the clock
    // advancing 1.4s in between.
    clock = SERVER_NOW;
    const first = renderToString(view([makeItem()]));
    clock = CLIENT_NOW;
    const second = renderToString(view([makeItem()]));

    // Compared on the age labels rather than byte-for-byte, so dnd-kit's
    // per-render id counter (#94) can't make this pass or fail for the wrong
    // reason.
    const ages = (h: string) => h.match(/\d+[smhd] ago/g);
    expect(ages(first)).toEqual(["12s ago"]);
    expect(ages(second)).toEqual(ages(first));
  });

  it("pins the freshness tier and the aging count too, not just the age label", async () => {
    // The age label was the reported symptom; it was not the only render-time
    // clock. `isAging`, `freshnessTier` and `shouldPrompt24h` each defaulted to
    // their own Date.now(), and each feeds RENDERED output: the amber tint, the
    // StatusPill's WORDS, and whether the "still needed?" nudge exists at all.
    // Demo mode (`demoOverrideSeconds`) puts those thresholds seconds apart,
    // well inside the server↔hydration gap — so a demo row crossing 🟢 Recent →
    // 🟡 Aging mismatches STRUCTURALLY, not just in a label.
    const demo: AgingSettings = { ...settings, demoOverrideSeconds: 10 };
    // 9.4s old at the server's clock (Recent); 10.8s old at the client's (Aging).
    const item = makeItem({ createdAt: new Date(SERVER_NOW - 9_400) });

    const { html, container, serverRow, recoverable } = await serverThenHydrate(
      [item],
      demo,
    );

    expect(html).toContain("🟢");
    expect(recoverable).toEqual([]);
    expect(serverRow!.isConnected).toBe(true);
    // Still the server's tier after hydration, and no "aging" count appeared.
    expect(container.textContent).toContain("🟢");
    expect(container.textContent).not.toContain("aging 🟡");
  });
});

// #94 — "aria-describedby names an id that is not in the document on every hard
// load of /", so the move instructions were announced to nobody.
//
// The cause was dnd-kit's own id generation: a per-render counter (the server's
// incremented per request, the browser's restarted at 0) naming an instructions
// node rendered into a PORTAL, which never server-renders at all. Both halves
// are gone with the library (#163) — the description is a plain node in the
// tree, and its id comes from React's `useId`, which is stable across the two
// renders by construction.
//
// Established in #94 and still true, which is why the suite above can demand
// zero recoverable errors: an attribute mismatch is reported through
// `console.error` and does NOT make React rebuild the tree, so this was never
// the #75/#105 class of fault. Kept as a comment because it is the reason the
// assertions above are shaped the way they are.
//
// The test below is deliberately a SWEEP rather than an assertion about the
// grip: #94's last open task asks for "a test that would have caught it", and
// one that only knows about the drag grip would not catch the next dangling
// reference somewhere else on the page.
describe("#94 no aria-describedby on the server-rendered inbox dangles", () => {
  it("every referenced id exists in the same server-rendered markup", async () => {
    const { html } = await serverThenHydrate([makeItem()]);

    const doc = document.implementation.createHTMLDocument("ssr");
    // Trusted input: the string our own renderToString just produced, parsed
    // into an inert document that never runs script or loads a subresource.
    doc.body.innerHTML = html;

    const referencing = Array.from(
      doc.body.querySelectorAll("[aria-describedby]"),
    );
    const dangling: string[] = [];
    for (const el of referencing) {
      for (const id of (el.getAttribute("aria-describedby") ?? "").split(
        /\s+/,
      )) {
        if (!id) continue;
        if (!doc.getElementById(id)) {
          dangling.push(`${el.tagName.toLowerCase()} → #${id}`);
        }
      }
    }

    // Proof the sweep is actually looking at something: an empty page would
    // also report zero dangling references, and a zero nothing looked at is
    // not a result.
    expect(
      referencing.length,
      "nothing on / uses aria-describedby",
    ).toBeGreaterThan(0);
    expect(dangling).toEqual([]);
  });

  it("survives hydration — the client resolves the same id the server wrote", async () => {
    const { container, serverRow, recoverable } = await serverThenHydrate([
      makeItem(),
    ]);

    const describing = container.querySelector("[aria-describedby]");
    expect(describing, "no aria-describedby survived hydration").not.toBeNull();
    const id = describing!.getAttribute("aria-describedby")!;
    expect(container.querySelector(`#${CSS.escape(id)}`)).not.toBeNull();

    // …and the server's tree is still the one on the page, so nothing about
    // this description reintroduces the #105 regeneration.
    expect(recoverable).toEqual([]);
    expect(serverRow!.isConnected).toBe(true);
  });
});
