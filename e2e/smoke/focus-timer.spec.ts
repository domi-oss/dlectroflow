import { test, expect } from "@playwright/test";
import { captureItem, needsReviewRow } from "../helpers";

// Flow 3: focus timer start → pause (redesigned /focus timer, MR ②). Create a
// to-do, launch focus from it (navigates to /focus/{stepId}), start the timer,
// then pause it and assert the control toggles to Resume.
test("focus timer starts and pauses", async ({ page }) => {
  const label = `E2E focus task ${Date.now()}`;
  await page.goto("/");

  await captureItem(page, label);

  // Item appears in the Needs review bucket; triage it into a to-do.
  const row = needsReviewRow(page, label);
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Add to-do" }).click();

  // It now lives in the single-task bucket with a Start Focus affordance.
  const todoRow = page
    .locator('[data-bucket="singleTask"]')
    .getByRole("listitem")
    .filter({ hasText: label });
  await expect(todoRow).toBeVisible();
  await todoRow.getByRole("button", { name: /Start Focus/ }).click();

  // ▶ Start Focus runs a server action (ensures the step exists) THEN
  // navigates — wait for the URL rather than asserting timer controls first.
  await page.waitForURL("**/focus/**");

  // Redesigned timer: a consistent ← Back returns to the focus launcher (no
  // server call — the session stays open/resumable).
  await expect(page.getByRole("link", { name: /back/i })).toHaveAttribute(
    "href",
    "/focus",
  );

  // The timer's own controls render their glyph as an aria-hidden lucide icon
  // and strip the leading glyph from the shared string, so the accessible name
  // is the bare text ("Start focusing", not "▶ Start focusing").
  await page.getByRole("button", { name: "Start focusing" }).click();

  // Complete-step + Pause/Resume are the on-page controls now; the old
  // "Pause for now" control + the gaveup screen were removed in the redesign.
  await expect(
    page.getByRole("button", { name: /complete step/i }),
  ).toBeVisible();

  // exact: true keeps these off the mini-player's "Play/Pause focus sound".
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  // The ring/countdown are animated and time-dependent — assert only the
  // stable post-pause control state, relying on Playwright auto-waiting.
  const resume = page.getByRole("button", { name: "Resume", exact: true });
  await expect(resume).toBeVisible();

  // ── #89: the paused ring is a paced breathing guide ───────────────────────
  // Unit tests cover the marker attribute; only a real browser can show that
  // the CSS actually reaches the element and moves it.
  const ring = page.locator(
    "[data-testid='timer-visual-ring'] svg[data-breathing]",
  );
  await expect(ring).toBeVisible();

  // The cadence, read off the running animation itself. A CSS animation's
  // `animation-timing-function` lands on each KEYFRAME (the effect's own easing
  // stays "linear"), so the per-stop easing below is where "eased at both
  // turning points" is actually asserted.
  const pacer = await ring.evaluate((el) => {
    const anim = el.getAnimations()[0] as CSSAnimation | undefined;
    // getKeyframes() is KeyframeEffect's, not the base AnimationEffect's.
    const effect = anim?.effect as KeyframeEffect | undefined;
    const timing = effect?.getTiming();
    return {
      name: anim?.animationName ?? null,
      state: anim?.playState ?? null,
      duration: timing?.duration ?? null,
      iterations: timing?.iterations ?? null,
      // No fill-mode: nothing can leave the ring frozen mid-breath.
      fill: timing?.fill ?? null,
      frames: (effect?.getKeyframes() ?? []).map((f) => ({
        offset: f.offset,
        easing: f.easing,
        scale: f.scale,
        opacity: f.opacity,
      })),
    };
  });
  expect(pacer).toEqual({
    name: "focus-breathe",
    state: "running",
    duration: 10_000,
    iterations: Infinity,
    fill: "none",
    // 10s split at 0.4 = a 4s inhale and a 6s exhale, growing INTO the ring's
    // resting size (scale 1) and back. Nothing else animates, so the pacer
    // cannot reflow the screen around it.
    frames: [
      { offset: 0, easing: "ease-in-out", scale: "0.9", opacity: "0.8" },
      { offset: 0.4, easing: "ease-in-out", scale: "1", opacity: "1" },
      { offset: 1, easing: "ease-in-out", scale: "0.9", opacity: "0.8" },
    ],
  });

  // …and it genuinely moves. Polls the ring's rendered width in-page and
  // resolves as soon as the spread proves a real expansion/contraction, so a
  // pacer that renders but never animates fails here instead of passing.
  await page.waitForFunction(
    (minSpread) => {
      const el = document.querySelector(
        "[data-testid='timer-visual-ring'] svg[data-breathing]",
      );
      if (!el) return false;
      const w = window as unknown as { __ringWidths?: number[] };
      const seen = (w.__ringWidths ??= []);
      seen.push(el.getBoundingClientRect().width);
      return Math.max(...seen) - Math.min(...seen) > minSpread;
    },
    10,
    { polling: 200, timeout: 15_000 },
  );

  // The remaining time stays exactly where it is throughout the cycle: the
  // readout is a sibling overlay, not part of what breathes. (The clock is
  // frozen while paused, so this box is stable unless the pacer moves it.)
  const readout = page
    .locator("[data-testid='timer-visual-ring']")
    .getByText(/^\d{1,2}:\d{2}$/);
  const readoutBox = await readout.boundingBox();
  // A deliberate wall-clock wait: the assertion is about what a >10%-of-cycle
  // slice of a running animation does to a neighbouring box, so there is no
  // state to wait for instead.
  await page.waitForTimeout(1_200);
  expect(await readout.boundingBox()).toEqual(readoutBox);

  // prefers-reduced-motion switches the pacer OFF outright (not down): the
  // component drops the element's marker, and usePrefersReducedMotion subscribes
  // to the media query, so it happens live.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(ring).toHaveCount(0);
  await expect(resume).toBeVisible(); // …and Resume is untouched either way
  // "no-preference", not null: null resets emulation to the SYSTEM default, so
  // on a host with OS "Reduce motion" on, the pacer would legitimately stay
  // away and the assertion below would fail for the wrong reason (Duo review).
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(ring).toBeVisible();

  // Leaving the paused state ends the breath.
  await resume.click();
  await expect(
    page.getByRole("button", { name: "Pause", exact: true }),
  ).toBeVisible();
  await expect(ring).toHaveCount(0);
});
