import { describe, it, expect } from "vitest";
import { assertReviewEnv } from "../../prisma/seed";

// Pure guard tests — no DB. The guard is the safety mechanism that keeps the
// review-app seed from EVER touching staging/production data.
describe("assertReviewEnv", () => {
  it("passes when the review signal SEED_REVIEW_APP=1 is set", () => {
    expect(() => assertReviewEnv({ SEED_REVIEW_APP: "1" })).not.toThrow();
  });

  it("passes when APP_ENV=review", () => {
    expect(() => assertReviewEnv({ APP_ENV: "review" })).not.toThrow();
  });

  it("passes for a GitLab review environment name (review/<iid>)", () => {
    expect(() => assertReviewEnv({ CI_ENVIRONMENT_NAME: "review/42" })).not.toThrow();
  });

  it("refuses when no review signal is present (empty env)", () => {
    expect(() => assertReviewEnv({})).toThrow(/no review environment signal/i);
  });

  it("does NOT treat NODE_ENV=production as a review signal (the review image runs NODE_ENV=production too)", () => {
    // NODE_ENV alone must never be enough to seed — otherwise the review image,
    // which boots with NODE_ENV=production, would look un-seedable OR prod would
    // look seedable. Only the explicit review signals count.
    expect(() => assertReviewEnv({ NODE_ENV: "production" })).toThrow(
      /no review environment signal/i,
    );
  });

  it("refuses a non-review env (staging) even WITH a review signal — allowlist, not blocklist", () => {
    // The whole point of the allowlist: a blocklist that only knew "production"
    // would happily seed a staging deploy that also had SEED_REVIEW_APP=1.
    expect(() =>
      assertReviewEnv({ SEED_REVIEW_APP: "1", APP_ENV: "staging" }),
    ).toThrow(/non-review environment/i);
    expect(() =>
      assertReviewEnv({ SEED_REVIEW_APP: "1", CI_ENVIRONMENT_NAME: "staging/7" }),
    ).toThrow(/non-review environment/i);
  });

  it("hard-refuses production even if a review signal is somehow also present", () => {
    expect(() =>
      assertReviewEnv({ SEED_REVIEW_APP: "1", APP_ENV: "production" }),
    ).toThrow(/production/i);
  });

  it("hard-refuses a GitLab production environment name", () => {
    expect(() =>
      assertReviewEnv({ SEED_REVIEW_APP: "1", CI_ENVIRONMENT_NAME: "production" }),
    ).toThrow(/production/i);
  });
});
