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
  // #253 — Add to-do moved off the row into its ▾ list, under the full label.
  await row.getByRole("button", { name: "All options" }).click();
  await row.getByRole("button", { name: "Add as single task to do" }).click();

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

  // ── #89: the live ring is a paced breathing guide ─────────────────────────
  // Unit tests cover the marker attribute; only a real browser can show that the
  // CSS actually reaches the element and moves it. It starts with the session,
  // so this runs before the pause below.
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

  // The countdown stays legible for the WHOLE session, not just at the two ends
  // of the breath: the readout is a sibling overlay, so the pacer must not move
  // or resize it while it ticks. Its centre and height are what to compare — the
  // box's width legitimately changes when "10:00" becomes "9:59" — and the
  // readout must carry no scale of its own.
  const readoutMetrics = await page.evaluate(async () => {
    const ringEl = document.querySelector(
      "[data-testid='timer-visual-ring'] svg[data-breathing]",
    )!;
    const readoutEl = [
      ...document.querySelectorAll("[data-testid='timer-visual-ring'] span"),
    ].find((el) => /^\d{1,2}:\d{2}$/.test(el.textContent ?? ""))!;
    const samples: {
      cx: number;
      cy: number;
      h: number;
      scale: string;
      ringW: number;
    }[] = [];
    for (let i = 0; i < 14; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const b = readoutEl.getBoundingClientRect();
      samples.push({
        cx: Math.round((b.left + b.right) / 2),
        cy: Math.round((b.top + b.bottom) / 2),
        h: Math.round(b.height),
        scale: getComputedStyle(readoutEl).scale,
        ringW: ringEl.getBoundingClientRect().width,
      });
    }
    const uniq = (key: "cx" | "cy" | "h" | "scale") => [
      ...new Set(samples.map((s) => s[key])),
    ];
    return {
      centres: uniq("cx").length,
      baselines: uniq("cy").length,
      heights: uniq("h").length,
      readoutScales: uniq("scale"),
      // Proof the samples straddled real movement rather than a still ring.
      ringSpread:
        Math.max(...samples.map((s) => s.ringW)) -
        Math.min(...samples.map((s) => s.ringW)),
    };
  });
  expect(readoutMetrics.centres).toBe(1);
  expect(readoutMetrics.baselines).toBe(1);
  expect(readoutMetrics.heights).toBe(1);
  expect(readoutMetrics.readoutScales).toEqual(["none"]);
  expect(readoutMetrics.ringSpread).toBeGreaterThan(10);

  // prefers-reduced-motion switches the pacer OFF outright (not down): the
  // component drops the element's marker, and usePrefersReducedMotion subscribes
  // to the media query, so it happens live, mid-session.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(ring).toHaveCount(0);
  // "no-preference", not null: null resets emulation to the SYSTEM default, so
  // on a host with OS "Reduce motion" on, the pacer would legitimately stay
  // away and the assertion below would fail for the wrong reason (Duo review).
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(ring).toBeVisible();

  // exact: true keeps these off the mini-player's "Play/Pause focus sound".
  // Note the animation's identity before pausing: it must SURVIVE the pause
  // rather than restart, which is the whole of "it keeps going".
  const before = await ring.evaluate((el) => {
    const a = el.getAnimations()[0];
    return { startTime: a.startTime, currentTime: a.currentTime };
  });
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  // The ring/countdown are animated and time-dependent — assert only the
  // stable post-pause control state, relying on Playwright auto-waiting.
  const resume = page.getByRole("button", { name: "Resume", exact: true });
  await expect(resume).toBeVisible();

  // Still breathing, and still the SAME breath: one animation on the element,
  // same start time, clock moved forward. A restart would reset startTime and
  // snap the ring back to the bottom of an exhale mid-session.
  await expect(ring).toBeVisible();
  const across = await ring.evaluate((el) => {
    const anims = el.getAnimations();
    const a = anims[0];
    return {
      count: anims.length,
      state: a.playState,
      startTime: a.startTime,
      currentTime: a.currentTime,
    };
  });
  expect(across.count).toBe(1);
  expect(across.state).toBe("running");
  expect(across.startTime).toEqual(before.startTime);
  expect(Number(across.currentTime)).toBeGreaterThan(
    Number(before.currentTime),
  );

  // …and out the other side. Resuming is not a restart either.
  await resume.click();
  await expect(
    page.getByRole("button", { name: "Pause", exact: true }),
  ).toBeVisible();
  await expect(ring).toBeVisible();
  expect(await ring.evaluate((el) => el.getAnimations()[0].startTime)).toEqual(
    before.startTime,
  );
});
