import { test, expect } from "@playwright/test";
import { captureItem, needsReviewRow, waitForShell } from "../helpers";
import { scanA11y } from "./axe-helpers";

// Mechanical accessibility (axe) gate over the core flow (issue #31):
//   inbox/capture → clarify → schedule → focus → reward.
// Runs inside the existing e2e_test CI job (any *.spec.ts under testDir), reusing
// the forged-owner session + next-start webServer from the smoke harness. Each
// scan fails only on NEW serious/critical violations vs. e2e/a11y/axe-baseline.json.
//
// reducedMotion keeps intro animations from being scanned mid-transition, which
// makes the axe snapshot deterministic across local + CI runs.
test.use({ contextOptions: { reducedMotion: "reduce" } });

test.describe("accessibility: core-flow routes (axe)", () => {
  // Statically-reachable core routes. inbox = capture, /focus = focus launcher,
  // /dashboard = reward; /library is the core navigation hub.
  const STATIC_ROUTES = [
    { path: "/", name: "inbox / capture" },
    { path: "/library", name: "library hub" },
    { path: "/focus", name: "focus launcher" },
    { path: "/dashboard", name: "reward / dashboard" },
  ] as const;

  for (const route of STATIC_ROUTES) {
    test(`no new serious/critical violations: ${route.name} (${route.path})`, async ({
      page,
    }) => {
      await page.goto(route.path);
      await waitForShell(page);
      await scanA11y(page, route.path);
    });
  }

  // #94's last open task, answered: "axe's aria-valid-attr-value should flag a
  // dangling aria-describedby, so work out why the existing scans do not reach
  // a drag grip carrying it."
  //
  // They do not reach it because **the inbox above is scanned empty.** `/` in
  // STATIC_ROUTES is loaded and scanned with no item captured, so there are no
  // rows, no row controls, and no `aria-describedby` anywhere on the page — a
  // clean scan of nothing at all. The rule was never suppressed and its impact
  // is critical; it simply had nothing to look at.
  //
  // Since #163 the row's move control carries the description (there is no
  // keyboard drag any more, so that control is the whole non-pointer path), and
  // its id comes from `useId` rather than a per-render counter. This scan is the
  // mechanical half of the proof — the SSR sweep in
  // `inbox-view.hydration.test.tsx` is the other half, and catches it one layer
  // earlier and without a browser.
  test("no new serious/critical violations: inbox WITH a row (/)", async ({
    page,
  }) => {
    const label = `A11y row ${Date.now()}`;
    await page.goto("/");
    await waitForShell(page);
    await captureItem(page, label);

    const row = needsReviewRow(page, label);
    await expect(row).toBeVisible();
    // The control the description hangs off. Asserting it is here first means a
    // future refactor that drops it fails loudly instead of quietly restoring
    // the "scan of nothing" this test exists to end.
    await expect(row.getByRole("button", { name: "Move to" })).toBeVisible();
    await scanA11y(page, "/ (with a row)");
  });

  // #100 — the header's identity popover, under the FULL ruleset rather than the
  // contrast-only gate. This is the surface where the mechanical rules earn their
  // keep: a `Popover.Popup` is a `dialog`, so it must carry an accessible name
  // (aria-dialog-name), and its trigger has to keep the visible handle inside its
  // accessible name (label-in-name). Both are attributes jsdom will happily
  // report; only a real accessibility tree can confirm them.
  //
  // Scanned on /help because the header is byte-identical on every route and
  // /help has no live clock re-rendering under the scan (#105).
  test("no new serious/critical violations: header identity popover open", async ({
    page,
  }) => {
    await page.goto("/help");
    await waitForShell(page);
    await page
      .locator("header")
      .getByRole("button", { name: /^Account: / })
      .click();
    await expect(page.getByRole("dialog", { name: "Account" })).toBeVisible();
    await scanA11y(page, "/help (identity popover open)");
  });

  // clarify + schedule live on the task-detail page. "Break into steps →" runs a
  // server action that creates the task (no AI required) and navigates to
  // /tasks/[taskId], which renders the breakdown/clarify editor and the schedule
  // control together.
  //
  // We scan the editor in *manual* mode (?edit=1&manual=1): it skips the AI
  // auto-request (no /api/breakdown call) and seeds one blank step, so the DOM is
  // fully deterministic — a stable, repeatable axe snapshot in both local + CI
  // (neither has an ANTHROPIC_API_KEY for the e2e run). The default AI-chat mode
  // renders differently depending on network/stream timing and is not a reliable
  // gate surface.
  test("no new serious/critical violations: clarify + schedule (/tasks/[taskId])", async ({
    page,
  }) => {
    const label = `A11y clarify ${Date.now()}`;
    await page.goto("/");
    await captureItem(page, label);

    const row = needsReviewRow(page, label);
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: /Break into steps/ }).click();
    await page.waitForURL("**/tasks/**");

    // Re-open the same task in the deterministic manual editor.
    const taskPath = new URL(page.url()).pathname;
    await page.goto(`${taskPath}?edit=1&manual=1`);
    await waitForShell(page);
    await expect(
      page.getByRole("textbox", { name: "Step text" }),
    ).toBeVisible();
    await scanA11y(page, "/tasks/[taskId]");
  });

  // focus timer. Triage a fresh item into a single to-do, then "▶ Start Focus"
  // lazily creates its one step and navigates to /focus/[stepId] (the timer).
  test("no new serious/critical violations: focus timer (/focus/[stepId])", async ({
    page,
  }) => {
    const label = `A11y focus ${Date.now()}`;
    await page.goto("/");
    await captureItem(page, label);

    const row = needsReviewRow(page, label);
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: "Add to-do" }).click();

    const todoRow = page
      .locator('[data-bucket="singleTask"]')
      .getByRole("listitem")
      .filter({ hasText: label });
    await expect(todoRow).toBeVisible();
    await todoRow.getByRole("button", { name: /Start Focus/ }).click();

    await page.waitForURL("**/focus/**");
    await waitForShell(page);
    // Wait for the timer page's own content (its <h1> step heading), not just the
    // shared app shell, so axe scans a fully-hydrated page — mirrors the clarify
    // test's wait on the "Step text" field. (The countdown span has no ARIA role.)
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await scanA11y(page, "/focus/[stepId]");

    // #89 — a RUNNING session is a different surface from the setup screen it was
    // scanned on: the near-black neon hero, a light/gradient readout, its own
    // control set, and now a continuously breathing ring. Scan it too — the timer
    // is guest-visible, and this is where the pacer paints.
    //
    // Both keys went into axe-baseline.json carrying ONE pre-existing violation
    // that this new coverage found on its first run: white on `bg-green-600`
    // ("Complete step" / "All done", renamed in #138) is 3.27:1, filed as #99. Baselined rather
    // than fixed here because it is a palette decision on the session's primary
    // CTA, not part of #89 — anything further on this surface still fails.
    //
    // Scanned in BOTH motion states. This file runs with prefers-reduced-motion
    // (see test.use above), which is exactly the state where the pacer must be
    // absent — so the first scan doubles as an independent check of that, driven
    // by a real context-level media preference rather than a live emulateMedia
    // flip. The second allows motion, which is the state a typical user is in.
    // Nothing inside the animated element is text (the ring is two circles), so
    // its scale/opacity cannot move an axe contrast result either way.
    await page.getByRole("button", { name: "Start focusing" }).click();
    await expect(
      page.getByRole("button", { name: /complete step/i }),
    ).toBeVisible();
    const pacer = page.locator(
      "[data-testid='timer-visual-ring'] svg[data-breathing]",
    );
    await expect(pacer).toHaveCount(0);
    await scanA11y(page, "/focus/[stepId] running");

    await page.emulateMedia({ reducedMotion: "no-preference" });
    await expect(pacer).toBeVisible();
    await scanA11y(page, "/focus/[stepId] running (breathing)");

    // #181 — the playlist/jump panel, EXPANDED. It is the surface with the most
    // mechanical a11y to get wrong on this page (a disclosure, a named checkbox
    // group, a set of headed lists and an aria-current item), and every one of
    // those is an attribute only a real accessibility tree can confirm.
    //
    // Each precondition is asserted before the scan rather than assumed. A
    // collapsed panel renders nothing at all, so a scan taken without them would
    // be a clean result that looked at none of this — and would keep on being
    // clean after the panel was broken.
    const panelToggle = page.getByRole("button", {
      name: "Playlists and tracks",
    });
    await expect(panelToggle).toBeVisible();
    await panelToggle.click();
    await expect(panelToggle).toHaveAttribute("aria-expanded", "true");
    // The e2e instance has no streamed catalog, so this is the BUNDLED extreme:
    // the ten shipped tracks and the column's default ["ambient-lofi"]. Both
    // sections must still be on screen — the tick-list because a selected
    // below-floor playlist is shown, the jump-list because the pool is never
    // empty.
    await expect(
      page.getByRole("group", { name: "Playlists", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Tracks", exact: true }),
    ).toBeVisible();
    await scanA11y(page, "/focus/[stepId] playlist panel open");
  });
});
