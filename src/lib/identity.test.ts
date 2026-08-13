import { describe, it, expect } from "vitest";
import {
  accountLabel,
  identityFor,
  identityLine,
  newAccountLine,
  providerDisplayName,
  roleWord,
} from "./identity";
import { UserRole } from "@/lib/constants";

describe("accountLabel", () => {
  it("uses the provider handle when there is one", () => {
    expect(
      accountLabel({
        id: "cabc123456789",
        handle: "dlectronique",
        displayName: null,
      }),
    ).toBe("dlectronique");
  });

  // Providers may withhold a username (AuthProfile.username is optional), and an
  // account with no label at all would leave the header blank — which is the
  // exact "did I lose everything?" ambiguity #100 exists to remove.
  it("falls back to a short account id when the provider gave no handle", () => {
    expect(
      accountLabel({ id: "cabc123456789", handle: null, displayName: null }),
    ).toBe("#cabc1234");
  });

  it("matches the People panel's label rule exactly (one label rule, not two)", () => {
    // people.ts had its own private copy of this; the panel and the header must
    // never disagree about what an account is called.
    const user = { id: "cxyz987654321", handle: null, displayName: null };
    expect(accountLabel(user)).toBe(`#${user.id.slice(0, 8)}`);
  });
});

/**
 * #252 — the header said `dlectronique`, and nobody's name is `dlectronique`.
 *
 * `User.displayName` is the first field on the account that a person chose for
 * themselves; the provider handle and the `#id` stub are both things that were
 * chosen FOR them. So it wins, and the two fallbacks keep their existing order
 * underneath it.
 *
 * The property the rest of this block is really about: **an account that never
 * sets one must render exactly as it does today.** #252 adds a nullable column,
 * and every row in production has `NULL` in it the moment the migration lands —
 * so a regression here is not an edge case, it is the default state of every
 * existing account.
 */
describe("accountLabel with a chosen display name (#252)", () => {
  const HANDLED = {
    id: "cabc123456789",
    handle: "dlectronique",
    displayName: null as string | null,
  };

  it("prefers the name the person chose over the provider's handle", () => {
    expect(accountLabel({ ...HANDLED, displayName: "Domi" })).toBe("Domi");
  });

  it("prefers it over the #id stub too, when the provider gave no handle", () => {
    expect(
      accountLabel({ ...HANDLED, handle: null, displayName: "Domi" }),
    ).toBe("Domi");
  });

  it("leaves an account that never set one exactly as it was", () => {
    expect(accountLabel(HANDLED)).toBe("dlectronique");
    expect(accountLabel({ ...HANDLED, handle: null })).toBe("#cabc1234");
  });

  // A stored "" is not null, so `displayName ?? handle` would hand the header an
  // empty string — the blank-label ambiguity #100 exists to remove, reintroduced
  // by the field meant to improve it. The writer normalises "" to null; this is
  // the second of the two guards, because the column is nullable and a row can
  // be edited by hand.
  it("falls through an empty or whitespace-only name rather than rendering nothing", () => {
    expect(accountLabel({ ...HANDLED, displayName: "" })).toBe("dlectronique");
    expect(accountLabel({ ...HANDLED, displayName: "   " })).toBe(
      "dlectronique",
    );
    expect(accountLabel({ ...HANDLED, handle: null, displayName: "  " })).toBe(
      "#cabc1234",
    );
  });

  it("trims the surrounding whitespace off a name that has some", () => {
    expect(accountLabel({ ...HANDLED, displayName: "  Domi  " })).toBe("Domi");
  });
});

describe("providerDisplayName", () => {
  // #74 — the provider has to be NAMED, and "gitlab" in a sentence reads as a
  // database value rather than as the thing you clicked to sign in.
  it("gives the known providers their real names", () => {
    expect(providerDisplayName("gitlab")).toBe("GitLab");
    expect(providerDisplayName("github")).toBe("GitHub");
    expect(providerDisplayName("google")).toBe("Google");
  });

  // A self-hoster's own provider must be reported verbatim rather than guessed
  // at or blanked: an unrecognised name is still the honest answer to "which
  // provider am I signed in with?".
  it("passes an unknown provider through untouched", () => {
    expect(providerDisplayName("acme-sso")).toBe("acme-sso");
  });
});

describe("roleWord", () => {
  it("names both roles", () => {
    expect(roleWord(UserRole.Owner)).toBe("Owner");
    expect(roleWord(UserRole.Member)).toBe("Member");
  });
});

describe("identityFor", () => {
  const OWNER = {
    id: "cowner1234567",
    handle: "gitlab_dlectronique",
    displayName: null as string | null,
    provider: "gitlab",
    role: UserRole.Owner,
  };

  it("builds the display identity from the server-resolved account", () => {
    expect(identityFor(OWNER)).toEqual({
      label: "gitlab_dlectronique",
      provider: "GitLab",
      role: UserRole.Owner,
    });
  });

  // The security property, asserted structurally so it cannot rot: this object
  // is handed to a CLIENT component, so anything on it is published to the
  // browser. Three keys, and the account id is not one of them.
  it("publishes exactly three fields — no id, no email, no workspace", () => {
    expect(Object.keys(identityFor(OWNER)).sort()).toEqual([
      "label",
      "provider",
      "role",
    ]);
  });

  it("never carries an email, even when one is on the account row", () => {
    const withEmail = { ...OWNER, email: "someone@example.com" };
    expect(JSON.stringify(identityFor(withEmail))).not.toContain(
      "@example.com",
    );
  });

  it("never carries the raw account id", () => {
    expect(JSON.stringify(identityFor(OWNER))).not.toContain(OWNER.id);
  });

  it("does not leak the id when it falls back to a short label", () => {
    // The fallback label is a PREFIX of the id by design (it is the only stable
    // thing left to show), so "no id" means the full id, not its first 8 chars.
    const noHandle = { ...OWNER, handle: null };
    expect(identityFor(noHandle).label).toBe("#cowner12");
    expect(JSON.stringify(identityFor(noHandle))).not.toContain(
      "cowner1234567",
    );
  });

  // #252 — the chosen name goes out through `label`, and does NOT become a
  // fourth published field. The three-key assertion above is the security
  // property; this says the new column arrives through it rather than beside it,
  // so a client component still has exactly one thing to render an account as.
  it("carries a chosen display name through `label`, not as a fourth field", () => {
    const named = { ...OWNER, displayName: "Domi" };
    expect(identityFor(named)).toEqual({
      label: "Domi",
      provider: "GitLab",
      role: UserRole.Owner,
    });
    expect(Object.keys(identityFor(named)).sort()).toEqual([
      "label",
      "provider",
      "role",
    ]);
    // The handle is not published alongside it: a person who renamed themselves
    // has one name on screen, not two.
    expect(JSON.stringify(identityFor(named))).not.toContain(
      "gitlab_dlectronique",
    );
  });
});

describe("identityLine", () => {
  // Composed as ONE JS string rather than JSX text around an expression: this
  // Next version's JSX transform trims a leading space on an
  // interpolation-adjacent line, which vitest's transform does not — the
  // production build read "rolling 30 dayswindow" while the unit suite was
  // green (see people-panel.tsx). Keeping the whole sentence in a tested pure
  // function removes the disagreement entirely.
  it("names the role and the provider in one line, for an owner", () => {
    expect(
      identityLine({ label: "x", provider: "GitLab", role: UserRole.Owner }),
    ).toBe("Owner · signed in with GitLab");
  });

  it("names the role and the provider in one line, for a member", () => {
    expect(
      identityLine({ label: "x", provider: "GitLab", role: UserRole.Member }),
    ).toBe("Member · signed in with GitLab");
  });

  it("keeps single spaces around every interpolation", () => {
    const line = identityLine({
      label: "x",
      provider: "acme-sso",
      role: UserRole.Member,
    });
    expect(line).not.toMatch(/ {2}/);
    expect(line).toMatch(/ with acme-sso$/);
  });
});

describe("newAccountLine", () => {
  const ADA = {
    label: "ada",
    provider: "GitLab",
    role: UserRole.Owner,
  };

  // #111 — the empty inbox of an account that has NEVER held anything. Same
  // "one JS string" rule as identityLine(), for the same reason: the sentence
  // is built from a voiced lead and two interpolations, and JSX text between
  // them is where this Next version's transform eats spaces.
  it("names the account inside the voiced lead, in plain", () => {
    expect(newAccountLine(ADA, "plain")).toBe(
      "Nothing here yet — this is a new account (ada, signed in with GitLab)",
    );
  });

  it("names the account inside the voiced lead, in playful", () => {
    expect(newAccountLine(ADA, "playful")).toBe(
      "🍳 Nothing here yet — this account is brand new (ada, signed in with GitLab)",
    );
  });

  // The whole point of #100/#111: the alarming case is signing in with the
  // WRONG provider account, which produces an empty workspace that looks like
  // data loss. Both facts have to be in the sentence for it to answer that.
  it("carries the handle and the provider in both voices", () => {
    for (const voice of ["plain", "playful"] as const) {
      const line = newAccountLine(ADA, voice);
      expect(line).toContain("ada");
      expect(line).toContain("GitLab");
    }
  });

  // A provider may withhold a username, in which case accountLabel() falls back
  // to a short account id — the line must still read as a sentence, not trail
  // off into an empty bracket.
  it("reads sensibly when the account has no handle", () => {
    expect(
      newAccountLine(
        { label: "#cabc1234", provider: "acme-sso", role: UserRole.Member },
        "plain",
      ),
    ).toBe(
      "Nothing here yet — this is a new account (#cabc1234, signed in with acme-sso)",
    );
  });

  it("keeps single spaces around every interpolation", () => {
    for (const voice of ["plain", "playful"] as const) {
      expect(newAccountLine(ADA, voice)).not.toMatch(/ {2}/);
    }
  });

  // The role is deliberately absent: it answers "what may I do here?", not
  // "whose workspace am I looking at?", and the header popover carries it on
  // every page already (identityLine).
  it("does not repeat the role the header popover already shows", () => {
    for (const voice of ["plain", "playful"] as const) {
      expect(newAccountLine(ADA, voice)).not.toContain("Owner");
    }
  });
});
