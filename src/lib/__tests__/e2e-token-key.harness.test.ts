import { describe, it, expect, beforeEach, afterEach } from "vitest";
import playwrightConfig from "../../../playwright.config";
import { TOKEN_ENC_KEY } from "../../../e2e/constants";
import {
  pinTokenEncKey,
  encryptFixtureToken,
} from "../../../e2e/google-credential";
import { decryptToken } from "../crypto/token-cipher";

/**
 * !200 — the e2e suite's token-encryption key, held in lock-step across the two
 * kinds of process that use it.
 *
 * The bug this exists to prevent is not a typo, it is an ASYMMETRY. Every server
 * the suite boots is handed `TOKEN_ENC_KEY` explicitly by playwright.config.ts,
 * which overrides whatever the environment carries. The fixture processes — the
 * runner that executes global-setup, and every worker that executes a spec —
 * used to resolve it the other way round: global-setup pinned the constant only
 * `if (!process.env.TOKEN_ENC_KEY)`, and schedule-menu.spec.ts pinned nothing at
 * all and relied on global-setup having mutated `process.env` before the workers
 * were forked.
 *
 * That asymmetry is invisible until something puts a DIFFERENT `TOKEN_ENC_KEY`
 * in the environment — and CI does, on exactly one ref. `TOKEN_ENC_KEY` is a
 * protected project CI/CD variable; GitLab withholds protected variables from
 * unprotected refs; `main` is the only protected branch. So the production key
 * reaches `e2e_test` on `main` and on no merge request. The fixtures encrypted
 * with it, the servers decrypted with the constant, `connected` (derived from
 * DECRYPTABILITY, not from ciphertext presence) went false, and four specs that
 * had passed twice on the same tree failed on the merge commit — with the member's
 * Settings rendering "Reconnect needed" and every 📅 falling back to .ics.
 *
 * A test that only compared two constants would be tautological (see the note in
 * scoping.harness.test.ts about that trap), so this asserts the two properties
 * that were actually false:
 *
 *   1. the fixture cipher IGNORES an ambient `TOKEN_ENC_KEY` — the regression
 *      test proper: it fails against the old conditional pin;
 *   2. every `webServer` entry really is handed that same key — the drift guard,
 *      in the spirit of src/lib/dockerfile-hygiene.test.ts, so removing the
 *      forwarding from one server's env cannot pass review silently.
 *
 * `vitest.setup.ts` seeds a valid `TOKEN_ENC_KEY` for the cipher's own tests, so
 * the ambient value is saved and restored around each case here.
 */

/** Not the suite key, and not vitest.setup.ts's key: a stand-in for production's. */
const AMBIENT_DECOY = "a".repeat(64);

/** The `webServer` array, which is what the suite actually boots (#118 added a second). */
const webServers = Array.isArray(playwrightConfig.webServer)
  ? playwrightConfig.webServer
  : [playwrightConfig.webServer!];

describe("e2e fixture token key", () => {
  let ambient: string | undefined;

  beforeEach(() => {
    ambient = process.env.TOKEN_ENC_KEY;
  });

  afterEach(() => {
    if (ambient === undefined) delete process.env.TOKEN_ENC_KEY;
    else process.env.TOKEN_ENC_KEY = ambient;
  });

  it("encrypts with the suite's key even when the environment names another", () => {
    process.env.TOKEN_ENC_KEY = AMBIENT_DECOY;

    const ciphertext = encryptFixtureToken("e2e-fixture-token");

    // Read it back the way the server under test does: with the suite's key.
    process.env.TOKEN_ENC_KEY = TOKEN_ENC_KEY;
    expect(decryptToken(ciphertext)).toBe("e2e-fixture-token");
  });

  it("does not produce ciphertext the ambient key could read", () => {
    process.env.TOKEN_ENC_KEY = AMBIENT_DECOY;

    const ciphertext = encryptFixtureToken("e2e-fixture-token");

    // The inverse of the case above, and the one that actually failed on `main`:
    // a token encrypted under the ambient key is undecryptable to the server, and
    // `decryptNullable` turns that into a silent "not connected".
    process.env.TOKEN_ENC_KEY = AMBIENT_DECOY;
    expect(() => decryptToken(ciphertext)).toThrow();
  });

  it("pins the key unconditionally, rather than only when unset", () => {
    process.env.TOKEN_ENC_KEY = AMBIENT_DECOY;
    pinTokenEncKey();
    expect(process.env.TOKEN_ENC_KEY).toBe(TOKEN_ENC_KEY);
  });

  it("still pins the key when the environment names none", () => {
    delete process.env.TOKEN_ENC_KEY;
    pinTokenEncKey();
    expect(process.env.TOKEN_ENC_KEY).toBe(TOKEN_ENC_KEY);
  });

  it("hands every server under test that same key", () => {
    // Both entries, so the member-google server (#118) cannot drift from the
    // default one — they read the same seeded rows out of the same database.
    expect(webServers.length).toBeGreaterThan(1);
    for (const server of webServers) {
      expect(server.env?.TOKEN_ENC_KEY).toBe(TOKEN_ENC_KEY);
    }
  });
});
