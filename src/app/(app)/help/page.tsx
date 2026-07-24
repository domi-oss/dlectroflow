import Link from "next/link";
import { getSettings } from "@/lib/db";
import { currentWorkspaceId } from "@/lib/workspace";
import { BackLink } from "@/components/nav/back-link";
import { type Voice } from "@/lib/strings";

// DB-backed only for the voice preference; content is static.
export const dynamic = "force-dynamic";

/**
 * User-facing "how it works" docs. Plain English (not the Plain/Playful app
 * voice — this page is meta). Written as self-contained sections so the same
 * content can seed a public GitLab Pages site later.
 */
export default async function HelpPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string }>;
}) {
  const workspaceId = await currentWorkspaceId();
  const [settings, { from }] = await Promise.all([
    getSettings(workspaceId),
    searchParams,
  ]);
  const voice: Voice = settings.voice === "playful" ? "playful" : "plain";

  return (
    <div className="space-y-8">
      <BackLink from={from} voice={voice} />

      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">Help &amp; getting started</h1>
        <p className="text-muted-foreground text-sm">
          A quick tour of how dlectroflow works — capture, review, break down,
          focus, done.
        </p>
      </header>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Getting started</h2>
        <p className="text-sm">The core loop is five moves:</p>
        <ol className="ml-5 list-decimal space-y-1 text-sm">
          <li>
            <strong>Brain dump</strong> anything into the inbox — no fields,
            just type and press Enter (or <kbd>/</kbd> to jump to the capture
            bar).
          </li>
          <li>
            <strong>Review</strong> each item under <em>Needs review</em>: break
            it into steps, add it as a single to-do, save it for later, or
            delete it.
          </li>
          <li>
            <strong>Break down</strong> big things into small, concrete steps
            with an AI assist — then tweak the list until it feels right.
          </li>
          <li>
            <strong>Focus</strong> one step at a time with the timer, or just
            tick steps off directly.
          </li>
          <li>
            <strong>Complete</strong> work to move it into the Completed bucket
            and earn points toward your streak.
          </li>
        </ol>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">The inbox &amp; freshness</h2>
        <p className="text-sm">
          Items in <em>Needs review</em> show a freshness pill that ages over
          time: <strong>Recent</strong> → <strong>Aging</strong> →{" "}
          <strong>Overdue</strong> → <strong>Way overdue</strong>. After a while
          an item asks &ldquo;still needed?&rdquo; — choose{" "}
          <strong>Still need it</strong> to reset its clock or{" "}
          <strong>Dismiss</strong> to stop the nudge. Use{" "}
          <strong>Save for later</strong> to pause freshness on something you
          are not ready for. You can tune the tier thresholds on the{" "}
          <Link href="/settings?from=help" className="underline">
            Settings
          </Link>{" "}
          page.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Task breakdown</h2>
        <p className="text-sm">
          When you break a task down, Claude proposes small steps. In the editor
          you can: ask for <strong>Fewer steps</strong> (consolidate) or{" "}
          <strong>More steps</strong> (split further),{" "}
          <strong>Add a step</strong> manually, drag the grip handle to{" "}
          <strong>reorder</strong>, remove a step, or{" "}
          <strong>send a step back to review</strong> as its own bigger task.
          Type free-form guidance in the &ldquo;Tell Claude how to adjust&rdquo;
          box anytime.
        </p>
        <p className="text-sm">
          Not every step needs the timer — on a task you can hit{" "}
          <strong>Focus</strong> for a timed block, or complete a step directly.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Voice &amp; settings</h2>
        <p className="text-sm">
          Switch between the calm <strong>Plain</strong> voice and the playful
          snack-themed voice, set your freshness thresholds, and manage
          reminders on the{" "}
          <Link href="/settings?from=help" className="underline">
            Settings
          </Link>{" "}
          page.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Guests &amp; AI limits</h2>
        <p className="text-sm">
          Signed-in guests can try the full flow with a daily cap on AI
          breakdowns; when the cap is reached (or the AI hiccups) you still get
          a hand-built starter plan you can edit. The workspace owner has higher
          limits and can pick the breakdown model.
        </p>
      </section>
    </div>
  );
}
