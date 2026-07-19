import { type Page } from "@playwright/test";

// Shared across the smoke specs: the capture bar's placeholder text, the
// capture-then-Enter step it takes to create a brain-dump item, and the
// Needs-review row locator specs assert on right after capturing. Kept
// minimal — only what's genuinely repeated across specs; anything that
// diverges (e.g. the single-task row lookups) stays local to its spec.
export const CAPTURE_PLACEHOLDER = "Brain dump anything… (Enter to save)";

// Capture a brain-dump item. The capture bar has no submit button — Enter
// saves it. Callers assert on the resulting row themselves.
export async function captureItem(page: Page, label: string): Promise<void> {
  const capture = page.getByPlaceholder(CAPTURE_PLACEHOLDER);
  await capture.fill(label);
  await capture.press("Enter");
}

// Locate a captured item's row in the Needs review bucket by its label.
export function needsReviewRow(page: Page, label: string) {
  return page
    .locator('[data-bucket="needsReview"]')
    .getByRole("listitem")
    .filter({ hasText: label });
}
