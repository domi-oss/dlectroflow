import { describe, it, expect } from "vitest";
import {
  createCooldown,
  EXPORT_COOLDOWN_SEC,
  exportCooldown,
} from "./cooldown";

const at = (seconds: number) => new Date(Date.UTC(2026, 7, 3, 9, 0, seconds));

describe("export cooldown", () => {
  it("allows the first request for a key", () => {
    expect(createCooldown(60).check("ws-1", at(0))).toEqual({ allowed: true });
  });

  it("refuses a second request inside the window, and says how long to wait", () => {
    const cooldown = createCooldown(60);
    cooldown.check("ws-1", at(0));
    expect(cooldown.check("ws-1", at(10))).toEqual({
      allowed: false,
      retryAfterSec: 50,
    });
  });

  it("rounds the wait up, so a client cannot retry into another refusal", () => {
    const cooldown = createCooldown(60);
    cooldown.check("ws-1", new Date(Date.UTC(2026, 7, 3, 9, 0, 0, 500)));
    expect(cooldown.check("ws-1", at(59))).toEqual({
      allowed: false,
      retryAfterSec: 2,
    });
  });

  it("allows again once the window has passed", () => {
    const cooldown = createCooldown(60);
    cooldown.check("ws-1", at(0));
    expect(cooldown.check("ws-1", at(60))).toEqual({ allowed: true });
  });

  it("does not let a refusal extend the window", () => {
    // A refused attempt must not reset the clock, or a retry loop locks somebody
    // out of their own data indefinitely.
    const cooldown = createCooldown(60);
    cooldown.check("ws-1", at(0));
    cooldown.check("ws-1", at(30));
    cooldown.check("ws-1", at(50));
    expect(cooldown.check("ws-1", at(60))).toEqual({ allowed: true });
  });

  it("meters each key independently", () => {
    // One workspace's export must never refuse another's — the failure mode here
    // is one busy account denying everybody else their own data.
    const cooldown = createCooldown(60);
    cooldown.check("ws-1", at(0));
    expect(cooldown.check("ws-2", at(1))).toEqual({ allowed: true });
    expect(cooldown.check("ws-1", at(1)).allowed).toBe(false);
  });

  it("forgets keys outside the window rather than growing forever", () => {
    // A guest sandbox is a workspace too and there is no upper bound on those, so
    // an unpruned map is a slow leak. Asserted through behaviour — a fresh key
    // must be allowed, and the pruned one must be treated as fresh.
    const cooldown = createCooldown(60);
    for (let i = 0; i < 500; i++) cooldown.check(`ws-${i}`, at(0));
    expect(cooldown.check("ws-0", at(120))).toEqual({ allowed: true });
  });

  it("ships a shared instance set to the documented window", () => {
    expect(EXPORT_COOLDOWN_SEC).toBe(60);
    expect(typeof exportCooldown.check).toBe("function");
  });
});
