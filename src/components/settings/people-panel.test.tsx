// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
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

function renderPanel(over: Partial<PeopleAdminView> = {}) {
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
      expect(
        within(card).getByLabelText(new RegExp(`ai policy for ${label}`, "i")),
      ).toBeInTheDocument();
      expect(
        within(card).getByLabelText(new RegExp(`quota for ${label}`, "i")),
      ).toBeInTheDocument();
      expect(
        within(card).getByRole("button", {
          name: new RegExp(`save ${label}`, "i"),
        }),
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
