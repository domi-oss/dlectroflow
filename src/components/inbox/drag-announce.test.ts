import { describe, it, expect } from "vitest";
import type { Voice } from "@/lib/strings";
import { BUCKET_ORDER, type BucketId } from "@/components/inbox/bucket";
import {
  MOVE_INSTRUCTIONS,
  spokenBucketName,
  liftAnnouncement,
  overAnnouncement,
  movedAnnouncement,
  notMovedAnnouncement,
  cancelledAnnouncement,
} from "@/components/inbox/drag-announce";

const VOICES: Voice[] = ["plain", "playful"];

describe("spokenBucketName", () => {
  it("keeps each voice's own wording", () => {
    expect(spokenBucketName("savedLater", "plain")).toBe("Saved for later");
    expect(spokenBucketName("savedLater", "playful")).toBe("Pantry");
    expect(spokenBucketName("multiStep", "plain")).toBe("Multi-step to-dos");
    expect(spokenBucketName("multiStep", "playful")).toBe("Sorted");
  });

  // A live region reads an emoji out by its CLDR name — "✅ Sorted" becomes
  // "check mark button Sorted". That is noise in the one channel a screen
  // reader user has for move feedback, so announcements drop the decoration.
  // Asserted over EVERY bucket × voice rather than the four known cases, so a
  // new playful glyph can't slip into the live region unnoticed.
  it("strips decorative glyphs from every bucket in every voice", () => {
    for (const bucket of BUCKET_ORDER) {
      for (const voice of VOICES) {
        const name = spokenBucketName(bucket, voice);
        expect(name.length, `${bucket}/${voice} is empty`).toBeGreaterThan(0);
        expect(name.trim(), `${bucket}/${voice} is not trimmed`).toBe(name);
        for (const ch of name) {
          expect(
            ch.codePointAt(0),
            `${bucket}/${voice} kept a non-latin glyph: ${JSON.stringify(ch)}`,
          ).toBeLessThan(0x2000);
        }
      }
    }
  });
});

describe("drag announcements", () => {
  const bucket: BucketId = "completed";

  it("names the item and the list it was lifted from", () => {
    const message = liftAnnouncement("buy oat milk", "needsReview", "plain");
    expect(message).toContain("buy oat milk");
    expect(message).toContain("Needs review");
  });

  it("names the list a drag is currently over", () => {
    const message = overAnnouncement("buy oat milk", bucket, "plain");
    expect(message).toContain("buy oat milk");
    expect(message).toContain("Completed");
  });

  // dnd-kit's built-in announcement named only the destination ("was dropped
  // over droppable area completed"). Naming BOTH ends is the "at least as good
  // as dnd-kit's" bar in #163: a user who cannot see the board has no other way
  // to know which list the item left.
  it("names both ends of a completed move", () => {
    const message = movedAnnouncement(
      "buy oat milk",
      "needsReview",
      bucket,
      "plain",
    );
    expect(message).toContain("buy oat milk");
    expect(message).toContain("Needs review");
    expect(message).toContain("Completed");
  });

  // An announcement that claims a move which did not happen is worse than
  // silence — it is the drag equivalent of a green pipeline over a skipped
  // gate. Both the no-op paths say so explicitly.
  it("says nothing moved when a drop changes nothing", () => {
    const message = notMovedAnnouncement(
      "buy oat milk",
      "needsReview",
      "plain",
    );
    expect(message).toContain("buy oat milk");
    expect(message).toContain("Needs review");
    expect(message).toMatch(/not moved|still in/i);
  });

  it("says nothing moved when a drag is cancelled", () => {
    const message = cancelledAnnouncement(
      "buy oat milk",
      "needsReview",
      "plain",
    );
    expect(message).toContain("buy oat milk");
    expect(message).toMatch(/cancel/i);
    expect(message).toContain("Needs review");
  });

  it("uses the reader's voice for the list names", () => {
    expect(
      movedAnnouncement("x", "needsReview", "savedLater", "playful"),
    ).toContain("Pantry");
    expect(
      movedAnnouncement("x", "needsReview", "savedLater", "plain"),
    ).toContain("Saved for later");
  });
});

describe("MOVE_INSTRUCTIONS", () => {
  // #163 — pragmatic-drag-and-drop is built on the platform's own drag and
  // drop, which has no keyboard equivalent, so the "Move to" control IS the
  // keyboard path rather than a fallback. The description has to say so, or a
  // keyboard user has no way to discover it.
  it("points at the Move to control rather than describing a keyboard drag", () => {
    expect(MOVE_INSTRUCTIONS).toMatch(/move to/i);
    expect(MOVE_INSTRUCTIONS).not.toMatch(/space bar|arrow keys/i);
  });
});
