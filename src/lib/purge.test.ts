import { describe, it, expect, afterEach } from "vitest";
import { guestSandboxTtlHours } from "./purge";

// NOTE: the purge execution logic moved to the self-contained CronJob
// entrypoint (prisma/scheduled-purge.ts, covered by scheduled-purge.test.ts)
// so it can run inside the standalone prod image. Only the guest-TTL helper
// remains here.

const original = process.env.GUEST_SANDBOX_TTL_HOURS;
afterEach(() => {
  if (original === undefined) delete process.env.GUEST_SANDBOX_TTL_HOURS;
  else process.env.GUEST_SANDBOX_TTL_HOURS = original;
});

describe("guestSandboxTtlHours", () => {
  it("defaults to 24 hours when GUEST_SANDBOX_TTL_HOURS is unset", () => {
    delete process.env.GUEST_SANDBOX_TTL_HOURS;
    expect(guestSandboxTtlHours()).toBe(24);
  });

  it("honors a configured GUEST_SANDBOX_TTL_HOURS value", () => {
    process.env.GUEST_SANDBOX_TTL_HOURS = "72";
    expect(guestSandboxTtlHours()).toBe(72);
  });
});
