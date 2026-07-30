// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  within,
  fireEvent,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// #35 Phase B — the owner-only People panel.
//
// The panel's whole job is "usage numbers only, never content", so the tests
// that matter most are the negative ones: no key material is ever rendered, an
// uncapped account is not shown a meaningless usage bar, and the owner cannot
// revoke themselves out of their own instance.

const invitePerson = vi.hoisted(() => vi.fn());
const withdrawInvitation = vi.hoisted(() => vi.fn());
const updatePersonAiPolicy = vi.hoisted(() => vi.fn());
const revokePerson = vi.hoisted(() => vi.fn());
const refresh = vi.hoisted(() => vi.fn());

vi.mock("@/app/actions/people", () => ({
  invitePerson,
  withdrawInvitation,
  updatePersonAiPolicy,
  revokePerson,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh }),
}));

import { PeoplePanel } from "@/components/settings/people-panel";
import type { PeopleAdminView } from "@/lib/people";

const NOW = new Date("2026-07-28T12:00:00.000Z").getTime();

function person(over: Partial<PeopleAdminView["people"][number]> = {}) {
  return {
    id: "u-1",
    handle: "ada",
    label: "ada",
    provider: "gitlab",
    role: "member" as const,
    status: "active" as const,
    aiPolicy: "capped",
    lastSeenAt: new Date(NOW - 2 * 3_600_000),
    usage: {
      used: 12,
      quota: 50,
      remaining: 38,
      windowStartedAt: new Date(NOW - 5 * 86_400_000),
      windowEndsAt: new Date(NOW + 25 * 86_400_000),
    },
    hasOwnKey: false,
    isSelf: false,
    ...over,
  };
}

function view(over: Partial<PeopleAdminView> = {}): PeopleAdminView {
  return {
    people: [person()],
    invitations: [],
    windowHours: 720,
    ...over,
  };
}

/**
 * The disclosure trigger — the panel's whole resting UI when collapsed.
 *
 * #101 moved the trigger INSIDE the h2 (the chevron has to sit before the title,
 * so the title is the trigger), which makes its accessible name the section's
 * registry label. `data-section-toggle` is the stable hook every section carries;
 * matching on the name alone would also match the nav's "People" jump link.
 */
function toggle(): HTMLButtonElement {
  return document.querySelector<HTMLButtonElement>(
    '[data-section-toggle="settings-people"]',
  )!;
}

/** The triage line in the heading band, beside the title. */
function summary(): HTMLElement {
  return document.getElementById(toggle().getAttribute("aria-describedby")!)!;
}

/**
 * Render the panel and OPEN it.
 *
 * The panel is collapsed by default (owner decision on !175 — it is ~1900px of
 * instance administration sitting above every other setting). Every test that
 * asserts on its contents needs it open, so the helper opens it. `fireEvent` so
 * the helper can stay synchronous and the existing tests keep their shape.
 */
function renderPanel(over: Partial<PeopleAdminView> = {}) {
  const result = render(
    <PeoplePanel view={view(over)} now={NOW} voice="plain" />,
  );
  fireEvent.click(toggle());
  return result;
}

/** Render and leave it in its resting, collapsed state. */
function renderCollapsed(over: Partial<PeopleAdminView> = {}) {
  return render(<PeoplePanel view={view(over)} now={NOW} voice="plain" />);
}

/** The card for one person, located by their displayed label. */
function personCard(label: string) {
  return screen
    .getByRole("list", { name: /accounts/i })
    .querySelector(`[data-person-label="${label}"]`) as HTMLElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  invitePerson.mockResolvedValue({ ok: true });
  withdrawInvitation.mockResolvedValue({ ok: true });
  updatePersonAiPolicy.mockResolvedValue({ ok: true });
  revokePerson.mockResolvedValue({ ok: true });
});

afterEach(cleanup);

describe("PeoplePanel — what it shows about each person", () => {
  it("renders the section heading as the shared jump target", () => {
    renderPanel();
    const heading = document.getElementById("settings-people");
    expect(heading).not.toBeNull();
    expect(heading!.tagName).toBe("H2");
    expect(heading!.textContent).toContain("People");
  });

  it("shows handle, provider, last seen, policy, usage and key presence", () => {
    const card = (renderPanel(), personCard("ada"));

    expect(card).toHaveTextContent("ada");
    expect(card).toHaveTextContent("gitlab");
    expect(card).toHaveTextContent("2h ago");
    // Usage this window against the quota.
    expect(card).toHaveTextContent("12 / 50");
    // Key presence as a boolean, in words.
    expect(within(card).getByText(/no own key/i)).toBeInTheDocument();
  });

  // Owner decision on !175: "I at least want the owner usage uncapped but
  // showing how much has been used in the people panel." So an uncapped row
  // shows a REAL COUNT with NO denominator — a bare number reads as
  // informational, where "142 / 50" reads as blown through a limit.
  it("shows an uncapped account's real usage as a count with NO denominator", () => {
    renderPanel({
      people: [
        person({
          id: "u-owner",
          label: "domi",
          role: "owner",
          aiPolicy: "uncapped",
          usage: {
            used: 142,
            quota: 50,
            remaining: 0,
            windowStartedAt: new Date(NOW - 5 * 86_400_000),
            windowEndsAt: new Date(NOW + 25 * 86_400_000),
          },
        }),
      ],
    });
    const card = personCard("domi");

    expect(card).toHaveTextContent("142 used this window");
    expect(card).toHaveTextContent(/uncapped/i);
    // No denominator anywhere: not the quota, not a remaining figure.
    expect(card).not.toHaveTextContent("/ 50");
    expect(card).not.toHaveTextContent("142 / ");
    // The quota field is inert while uncapped, so it is disabled rather than
    // silently accepting a number that changes nothing.
    expect(within(card).getByLabelText(/quota for domi/i)).toBeDisabled();
  });

  it("shows an uncapped account that has never used AI as a zero count, not a blank", () => {
    renderPanel({
      people: [
        person({
          label: "domi",
          aiPolicy: "uncapped",
          usage: {
            used: 0,
            quota: 50,
            remaining: 50,
            windowStartedAt: null,
            windowEndsAt: null,
          },
        }),
      ],
    });

    expect(personCard("domi")).toHaveTextContent("0 used this window");
  });

  it("shows the window start for an uncapped account too — it is metered now", () => {
    // Uncapped records against the same rolling window, so the owner needs to
    // see when the count resets, exactly as for a capped account.
    renderPanel({
      people: [
        person({
          label: "domi",
          aiPolicy: "uncapped",
          usage: {
            used: 12,
            quota: 50,
            remaining: 38,
            windowStartedAt: new Date(NOW - 5 * 86_400_000),
            windowEndsAt: new Date(NOW + 25 * 86_400_000),
          },
        }),
      ],
    });

    expect(personCard("domi")).toHaveTextContent(/window began/i);
  });

  it("switching the dropdown to uncapped drops the denominator immediately", async () => {
    const user = userEvent.setup();
    renderPanel();
    const card = personCard("ada");
    expect(card).toHaveTextContent("12 / 50");

    await user.selectOptions(
      within(card).getByLabelText(/ai policy for ada/i),
      "uncapped",
    );

    expect(card).toHaveTextContent("12 used this window");
    expect(card).not.toHaveTextContent("12 / 50");
  });

  it("shows an account on its OWN key as billed to them, with no meter", () => {
    renderPanel({
      people: [
        person({ label: "grace", aiPolicy: "own_key", hasOwnKey: true }),
      ],
    });
    const card = personCard("grace");

    expect(within(card).getByText(/own key set/i)).toBeInTheDocument();
    expect(card).not.toHaveTextContent("12 / 50");
  });

  it("shows a capped account whose own key is present as billed to them", () => {
    // A present key wins over the policy (see consumeUserBreakdown), so a
    // "capped" label next to a usage bar would be a lie.
    renderPanel({
      people: [person({ label: "grace", aiPolicy: "capped", hasOwnKey: true })],
    });
    const card = personCard("grace");

    expect(within(card).getByText(/own key set/i)).toBeInTheDocument();
    expect(card).not.toHaveTextContent("12 / 50");
  });

  it("states the rolling window in words so the numbers mean something", () => {
    renderPanel();
    expect(screen.getByText(/rolling 30 days/i)).toBeInTheDocument();
  });

  it("says outright that the owner sees numbers and never content", () => {
    renderPanel();
    expect(screen.getByText(/never .*content/i)).toBeInTheDocument();
  });

  it("NEVER renders key material, an email, or a workspace id", () => {
    renderPanel({
      people: [person({ hasOwnKey: true, aiPolicy: "own_key" })],
    });
    const html = document.body.innerHTML;
    expect(html).not.toMatch(/sk-/);
    expect(html).not.toMatch(/@/);
    expect(html).not.toMatch(/workspace/i);
  });

  it("shows status as words, never colour alone", () => {
    renderPanel({
      people: [person({ label: "gone", status: "revoked" })],
    });
    expect(
      within(personCard("gone")).getByText(/revoked/i),
    ).toBeInTheDocument();
  });
});

describe("PeoplePanel — inviting", () => {
  it("sends the typed identity and note, then refreshes", async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.type(screen.getByLabelText(/username or email/i), "grace");
    await user.type(screen.getByLabelText(/note/i), "new teammate");
    await user.click(screen.getByRole("button", { name: /send invitation/i }));

    expect(invitePerson).toHaveBeenCalledWith({
      identity: "grace",
      note: "new teammate",
    });
    expect(refresh).toHaveBeenCalled();
  });

  it("does not submit an empty identity", async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByRole("button", { name: /send invitation/i }));

    expect(invitePerson).not.toHaveBeenCalled();
  });

  it("reports a rejected invitation in words, as an alert", async () => {
    invitePerson.mockResolvedValue({ ok: false, error: "already_invited" });
    const user = userEvent.setup();
    renderPanel();

    await user.type(screen.getByLabelText(/username or email/i), "ada");
    await user.click(screen.getByRole("button", { name: /send invitation/i }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/already invited/i);
  });

  it("clears the form after a successful invitation", async () => {
    const user = userEvent.setup();
    renderPanel();
    const identity = screen.getByLabelText(/username or email/i);

    await user.type(identity, "grace");
    await user.click(screen.getByRole("button", { name: /send invitation/i }));

    expect(await screen.findByRole("status")).toHaveTextContent(/invited/i);
    expect(identity).toHaveValue("");
  });
});

describe("PeoplePanel — invitations list", () => {
  const invitations = [
    {
      id: "a-1",
      provider: "gitlab",
      identity: "grace",
      note: "new teammate",
      invitedAt: new Date(NOW - 86_400_000),
      claimed: false,
    },
    {
      id: "a-2",
      provider: "gitlab",
      identity: "ada",
      note: null,
      invitedAt: new Date(NOW - 3 * 86_400_000),
      claimed: true,
    },
  ];

  it("lists pending and claimed invitations, distinguishing them in words", () => {
    renderPanel({ invitations });
    const list = screen.getByRole("list", { name: /invitations/i });

    expect(within(list).getByText(/grace/)).toBeInTheDocument();
    expect(within(list).getByText(/pending/i)).toBeInTheDocument();
    expect(within(list).getByText(/claimed/i)).toBeInTheDocument();
  });

  it("offers withdraw only for a PENDING invitation", async () => {
    renderPanel({ invitations });

    expect(
      screen.getByRole("button", {
        name: /withdraw the invitation for grace/i,
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: /withdraw the invitation for ada/i,
      }),
    ).not.toBeInTheDocument();
  });

  it("withdraws a pending invitation", async () => {
    const user = userEvent.setup();
    renderPanel({ invitations });

    await user.click(
      screen.getByRole("button", {
        name: /withdraw the invitation for grace/i,
      }),
    );

    expect(withdrawInvitation).toHaveBeenCalledWith("a-1");
  });

  it("says so when there is nothing pending", () => {
    renderPanel({ invitations: [] });
    expect(screen.getByText(/no invitations yet/i)).toBeInTheDocument();
  });
});

describe("PeoplePanel — changing a policy", () => {
  it("saves the chosen policy and quota for that person only", async () => {
    const user = userEvent.setup();
    renderPanel();
    const card = personCard("ada");

    await user.selectOptions(
      within(card).getByLabelText(/ai policy for ada/i),
      "uncapped",
    );
    await user.click(within(card).getByRole("button", { name: /save ada/i }));

    expect(updatePersonAiPolicy).toHaveBeenCalledWith({
      userId: "u-1",
      aiPolicy: "uncapped",
      aiQuota: 50,
    });
  });

  it("sends an edited quota as a number", async () => {
    const user = userEvent.setup();
    renderPanel();
    const card = personCard("ada");
    const quota = within(card).getByLabelText(/quota for ada/i);

    await user.clear(quota);
    await user.type(quota, "25");
    await user.click(within(card).getByRole("button", { name: /save ada/i }));

    expect(updatePersonAiPolicy).toHaveBeenCalledWith({
      userId: "u-1",
      aiPolicy: "capped",
      aiQuota: 25,
    });
  });

  it("offers exactly the three policies the constraint allows", () => {
    renderPanel();
    const select = within(personCard("ada")).getByLabelText(
      /ai policy for ada/i,
    ) as HTMLSelectElement;

    expect([...select.options].map((o) => o.value)).toEqual([
      "uncapped",
      "capped",
      "own_key",
    ]);
  });

  it("surfaces a rejected save as an alert rather than silently doing nothing", async () => {
    updatePersonAiPolicy.mockResolvedValue({ ok: false, error: "not_found" });
    const user = userEvent.setup();
    renderPanel();
    const card = personCard("ada");

    await user.click(within(card).getByRole("button", { name: /save ada/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /no longer exists/i,
    );
  });
});

describe("PeoplePanel — revoking", () => {
  it("asks for confirmation before revoking", async () => {
    const user = userEvent.setup();
    renderPanel();
    const card = personCard("ada");

    await user.click(within(card).getByRole("button", { name: /revoke ada/i }));

    expect(revokePerson).not.toHaveBeenCalled();
    expect(within(card).getByText(/sign in immediately/i)).toBeInTheDocument();

    await user.click(
      within(card).getByRole("button", { name: /yes, revoke ada/i }),
    );
    expect(revokePerson).toHaveBeenCalledWith("u-1");
  });

  it("can be cancelled, leaving the account alone", async () => {
    const user = userEvent.setup();
    renderPanel();
    const card = personCard("ada");

    await user.click(within(card).getByRole("button", { name: /revoke ada/i }));
    await user.click(within(card).getByRole("button", { name: /^cancel$/i }));

    expect(revokePerson).not.toHaveBeenCalled();
    expect(
      within(card).getByRole("button", { name: /revoke ada/i }),
    ).toBeInTheDocument();
  });

  it("says the data survives for 30 days, so the owner knows it is reversible", async () => {
    const user = userEvent.setup();
    renderPanel();
    const card = personCard("ada");

    await user.click(within(card).getByRole("button", { name: /revoke ada/i }));

    expect(within(card).getByText(/30 days/i)).toBeInTheDocument();
  });

  it("warns that any Google connection is withdrawn with the access (#126)", async () => {
    // Revoking now reaches into the member's OWN Google account (they cannot
    // reach Disconnect once frozen, so the app withdraws the grant for them).
    // An effect outside this instance is not something to spring on the owner
    // after the fact. Phrased conditionally on purpose: the panel must not
    // disclose WHETHER this person has connected Google — that is the claim the
    // Privacy Policy makes and the scoping harness enforces.
    const user = userEvent.setup();
    renderPanel();
    const card = personCard("ada");

    await user.click(within(card).getByRole("button", { name: /revoke ada/i }));

    const warning = within(card).getByText(
      /any Google Tasks connection of theirs/i,
    );
    expect(warning).toBeInTheDocument();
    // "asks Google", not "revoked at Google". Revoking is a call that can be
    // refused (`disconnectGoogle` reads `res.ok`), and this must not promise an
    // outcome the Privacy Policy is careful not to promise either.
    expect(warning).toHaveTextContent(/asks Google to revoke the grant/i);
    expect(warning).not.toHaveTextContent(/and revoked at Google/i);
  });

  it("offers NO revoke control on the owner's own row", () => {
    renderPanel({
      people: [
        person({ id: "u-owner", label: "domi", role: "owner", isSelf: true }),
      ],
    });
    const card = personCard("domi");

    expect(
      within(card).queryByRole("button", { name: /revoke/i }),
    ).not.toBeInTheDocument();
    expect(within(card).getByText(/this is you/i)).toBeInTheDocument();
  });

  it("offers no revoke control for an already-revoked account", () => {
    renderPanel({ people: [person({ label: "gone", status: "revoked" })] });
    expect(
      within(personCard("gone")).queryByRole("button", { name: /revoke/i }),
    ).not.toBeInTheDocument();
  });
});

describe("PeoplePanel — accessibility", () => {
  it("labels every control with the person it acts on", () => {
    renderPanel({
      people: [
        person({ id: "u-1", label: "ada" }),
        person({ id: "u-2", label: "grace" }),
      ],
    });

    for (const label of ["ada", "grace"]) {
      const card = personCard(label);
      // Exact strings, not case-insensitive regexes built from `label`: the
      // accessible names are known exactly, an exact match cannot pass on a
      // near-miss, and it keeps a regex-from-a-variable out of the codebase
      // (semgrep `non-literal-regexp`, flagged on !175).
      expect(
        within(card).getByLabelText(`AI policy for ${label}`),
      ).toBeInTheDocument();
      expect(
        within(card).getByLabelText(`Quota for ${label}`),
      ).toBeInTheDocument();
      expect(
        within(card).getByRole("button", { name: `Save ${label}` }),
      ).toBeInTheDocument();
    }
  });

  it("gives the two lists accessible names", () => {
    renderPanel({
      invitations: [
        {
          id: "a-1",
          provider: "gitlab",
          identity: "grace",
          note: null,
          invitedAt: new Date(NOW),
          claimed: false,
        },
      ],
    });
    expect(screen.getByRole("list", { name: /accounts/i })).toBeInTheDocument();
    expect(
      screen.getByRole("list", { name: /invitations/i }),
    ).toBeInTheDocument();
  });

  it("exposes last seen as a machine-readable time as well as prose", () => {
    renderPanel();
    const time = within(personCard("ada")).getByText("2h ago");
    expect(time.tagName).toBe("TIME");
    expect(time).toHaveAttribute(
      "dateTime",
      new Date(NOW - 2 * 3_600_000).toISOString(),
    );
  });

  it("announces a successful change politely, and a failure assertively", async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(
      within(personCard("ada")).getByRole("button", { name: /save ada/i }),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(/saved/i);

    updatePersonAiPolicy.mockResolvedValue({ ok: false, error: "not_allowed" });
    await user.click(
      within(personCard("ada")).getByRole("button", { name: /save ada/i }),
    );
    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });
});

// ── Duo review on !175 ───────────────────────────────────────────────────────
describe("PeoplePanel — the card is internally consistent mid-edit", () => {
  it("updates the AI line when the policy dropdown changes, before saving", async () => {
    // Duo review finding, verified against the code: `metered` (which disables
    // the quota field and hides the window line) read the LOCAL dropdown state
    // while the AI line read the SAVED prop, so picking "Uncapped" left a
    // disabled quota field sitting next to "12 / 50 breakdowns used".
    const user = userEvent.setup();
    renderPanel();
    const card = personCard("ada");

    expect(card).toHaveTextContent("12 / 50");

    await user.selectOptions(
      within(card).getByLabelText(/ai policy for ada/i),
      "uncapped",
    );

    expect(card).toHaveTextContent(/uncapped/i);
    expect(card).not.toHaveTextContent("12 / 50");
    // Still a count — uncapped is metered, just not enforced (!175).
    expect(card).toHaveTextContent("12 used this window");
    expect(within(card).getByLabelText(/quota for ada/i)).toBeDisabled();
  });

  it("goes back to the meter when the policy is switched back to capped", async () => {
    const user = userEvent.setup();
    renderPanel();
    const card = personCard("ada");
    const select = within(card).getByLabelText(/ai policy for ada/i);

    await user.selectOptions(select, "uncapped");
    await user.selectOptions(select, "capped");

    expect(card).toHaveTextContent("12 / 50");
    expect(within(card).getByLabelText(/quota for ada/i)).toBeEnabled();
  });

  it("keeps 'billed to their own key' whatever the dropdown says — a present key wins", async () => {
    // Matches consumeUserBreakdown: the key is checked BEFORE the policy, so no
    // dropdown selection can make an own-key account look metered.
    const user = userEvent.setup();
    renderPanel({
      people: [
        person({ label: "grace", aiPolicy: "own_key", hasOwnKey: true }),
      ],
    });
    const card = personCard("grace");

    await user.selectOptions(
      within(card).getByLabelText(/ai policy for grace/i),
      "capped",
    );

    expect(within(card).getByText(/own key set/i)).toBeInTheDocument();
    expect(card).not.toHaveTextContent("12 / 50");
  });

  it("sends the TRIMMED identity to the server action, matching what it reports", async () => {
    // Duo review finding: the action trims server-side either way, but sending
    // the raw value while reporting the trimmed one meant the client and the
    // server disagreed about what was just invited.
    const user = userEvent.setup();
    renderPanel();

    await user.type(screen.getByLabelText(/username or email/i), "  grace  ");
    await user.click(screen.getByRole("button", { name: /send invitation/i }));

    expect(invitePerson).toHaveBeenCalledWith({
      identity: "grace",
      note: undefined,
    });
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Invited grace.",
    );
  });
});

describe("PeoplePanel — the intro sentence reads as a sentence", () => {
  it("keeps a space between the window length and the word 'window'", () => {
    // Caught by eyeballing the !175 screenshots: the served HTML was
    // `rolling 30 days<!-- -->window`. The JSX had the space at the START of a
    // line immediately after `{windowLabel(...)}`, and this Next version's JSX
    // transform trimmed it (AGENTS.md: "This is NOT the Next.js you know").
    // Every interpolation-adjacent space now lives inside a JS string, where
    // nothing can trim it.
    renderPanel();
    const intro = screen.getByText(/Who can use this instance/);
    expect(intro.textContent).toContain("rolling 30 days window");
    expect(intro.textContent).not.toContain("dayswindow");
  });

  it("states the window length from the view, not a hardcoded 30 days", () => {
    renderPanel({ windowHours: 168 });
    expect(screen.getByText(/Who can use this instance/).textContent).toContain(
      "rolling 7 days window",
    );
  });
});

// ── Owner decision on !175 — the panel is a disclosure ───────────────────────
//
// Expanded, this is ~1900px of instance administration sitting at the very top
// of /settings, before the timer style and every other personal preference.
// Someone coming to Settings to change their own timer should not scroll past
// people management to reach it. So: collapsed by default, every visit, with a
// summary in the collapsed row that answers "is anything up?".
describe("PeoplePanel — collapsed by default", () => {
  it("renders collapsed, with the body hidden and the trigger saying so", () => {
    renderCollapsed();

    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    const body = document.getElementById(
      toggle().getAttribute("aria-controls")!,
    );
    expect(body).not.toBeNull();
    expect(body).not.toBeVisible();
  });

  it("hides every control behind the disclosure while collapsed", () => {
    renderCollapsed();

    // `getByRole` walks the accessibility tree, so a `hidden` subtree is gone
    // from it — which is exactly what a collapsed disclosure must be.
    expect(
      screen.queryByRole("button", { name: /send invitation/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("list", { name: /accounts/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /revoke ada/i }),
    ).not.toBeInTheDocument();
  });

  it("still renders the section heading as the jump target when collapsed", () => {
    // The nav must be able to jump to it whether or not it is open.
    renderCollapsed();
    const heading = document.getElementById("settings-people");
    expect(heading).not.toBeNull();
    expect(heading!.tagName).toBe("H2");
  });

  it("opens on click and closes again, keeping aria-expanded honest", async () => {
    const user = userEvent.setup();
    renderCollapsed();

    await user.click(toggle());
    expect(toggle()).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByRole("button", { name: /send invitation/i }),
    ).toBeInTheDocument();

    await user.click(toggle());
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByRole("button", { name: /send invitation/i }),
    ).not.toBeInTheDocument();
  });

  it("is operable from the keyboard, with a visible focus treatment", async () => {
    const user = userEvent.setup();
    renderCollapsed();

    await user.tab();
    expect(toggle()).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(toggle()).toHaveAttribute("aria-expanded", "true");
    await user.keyboard(" ");
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    // The shared focus-visible ring the rest of the app uses.
    expect(toggle().className).toContain("focus-visible:ring-2");
  });

  it("points aria-controls at the element it actually controls", () => {
    renderCollapsed();
    const id = toggle().getAttribute("aria-controls");
    expect(id).toBeTruthy();
    expect(document.getElementById(id!)).not.toBeNull();
  });
});

describe("PeoplePanel — the collapsed row earns its space", () => {
  it("summarises accounts, revocations and pending invitations", () => {
    renderCollapsed({
      people: [
        person({ id: "u-1", label: "domi", role: "owner" }),
        person({ id: "u-2", label: "grace" }),
        person({ id: "u-3", label: "ada" }),
        person({ id: "u-4", label: "linus" }),
        person({ id: "u-5", label: "hopper", status: "revoked" }),
      ],
      invitations: [
        {
          id: "a-1",
          provider: "gitlab",
          identity: "mary",
          note: null,
          invitedAt: new Date(NOW),
          claimed: false,
        },
        {
          id: "a-2",
          provider: "gitlab",
          identity: "kate",
          note: null,
          invitedAt: new Date(NOW),
          claimed: false,
        },
        {
          id: "a-3",
          provider: "gitlab",
          identity: "grace",
          note: null,
          invitedAt: new Date(NOW),
          claimed: true,
        },
      ],
    });

    expect(summary()).toHaveTextContent(
      "5 accounts · 1 revoked · 2 invitations pending",
    );
  });

  it("omits the clauses that are zero — the summary is for triage, not a dashboard", () => {
    renderCollapsed({
      people: [person({ id: "u-1", label: "domi", role: "owner" })],
      invitations: [],
    });

    expect(summary()).toHaveTextContent("1 account");
    expect(summary()).not.toHaveTextContent(/revoked/);
    expect(summary()).not.toHaveTextContent(/pending/);
  });

  it("counts only UNCLAIMED invitations as pending", () => {
    renderCollapsed({
      invitations: [
        {
          id: "a-1",
          provider: "gitlab",
          identity: "grace",
          note: null,
          invitedAt: new Date(NOW),
          claimed: true,
        },
      ],
    });
    expect(summary()).not.toHaveTextContent(/pending/);
  });

  it("pluralises properly, so the row never reads like a bug", () => {
    renderCollapsed({
      people: [person({ id: "u-1", status: "revoked" })],
      invitations: [
        {
          id: "a-1",
          provider: "gitlab",
          identity: "mary",
          note: null,
          invitedAt: new Date(NOW),
          claimed: false,
        },
      ],
    });
    expect(summary()).toHaveTextContent(
      "1 account · 1 revoked · 1 invitation pending",
    );
  });

  it("carries NO usage totals — the collapsed row is triage, not a dashboard", () => {
    renderCollapsed();
    // The default fixture has a person with 12/50 used; none of it belongs here.
    expect(summary()).not.toHaveTextContent(/used/);
    expect(summary()).not.toHaveTextContent(/\d+ \/ \d+/);
  });

  it("names the trigger after the section and DESCRIBES it with the summary", () => {
    renderCollapsed({ people: [person()], invitations: [] });
    // #101: the visible label of a section heading is the section's name, and
    // WCAG 2.5.3 (Label in Name) wants the accessible name to be that. The
    // triage line is carried as the DESCRIPTION instead, so a screen-reader user
    // still hears it — "People, collapsed, button, 1 account" — without the
    // heading being renamed to a running commentary.
    expect(toggle()).toHaveAccessibleName("People");
    expect(toggle()).toHaveAccessibleDescription("1 account");
    // State comes from aria-expanded, not from the words, so it cannot drift.
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle());
    expect(toggle()).toHaveAttribute("aria-expanded", "true");
    expect(toggle()).toHaveAccessibleName("People");
  });

  it("keeps the summary visible while expanded, so the row does not jump", () => {
    renderCollapsed();
    const before = summary().textContent;
    fireEvent.click(toggle());
    expect(summary()).toBeVisible();
    expect(summary().textContent).toBe(before);
  });
});
