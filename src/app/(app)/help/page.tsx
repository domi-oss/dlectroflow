import Link from "next/link";
import { getSettings } from "@/lib/db";
import { currentWorkspaceId } from "@/lib/workspace";
import { BackLink } from "@/components/nav/back-link";
import { SectionNav } from "@/components/nav/section-nav";
import { SectionHeading } from "@/components/nav/section-heading";
import { HELP_SECTIONS } from "@/lib/section-nav";
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

      {/* #72 — the page map. Sticky so it stays reachable on a long scroll.
          #131 — and the way OUT rides with it: the same `from` the control
          above was given, so both copies resolve to the same origin. */}
      <SectionNav
        sections={HELP_SECTIONS}
        voice={voice}
        label="Help sections"
        from={from}
      />

      <section className="space-y-2">
        <SectionHeading id="help-getting-started" voice={voice} />
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
        <SectionHeading id="help-inbox-freshness" voice={voice} />
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
        <SectionHeading id="help-task-breakdown" voice={voice} />
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
        <SectionHeading id="help-focus-session" voice={voice} />
        <p className="text-sm">
          Opening a step shows one number and one action. Pick how long you want
          from the duration <strong>chips</strong> (the step&rsquo;s own
          estimate is already selected), then press{" "}
          <strong>Start focusing</strong>. While the timer runs you can{" "}
          <strong>Complete step</strong>, nudge the clock by a few minutes
          either way, or <strong>Pause</strong>.
        </p>
        <p className="text-sm">
          Pausing is real: the session is saved, so you can close the tab, come
          back later or open it on another device and pick up where you left off
          — the clock does not keep draining while you are away. When a paused
          session exists, the step offers <strong>Resume</strong> with the time
          remaining, or <strong>Start fresh</strong> if you would rather begin
          again. Choosing &ldquo;Start fresh&rdquo; only reveals the duration
          chips; nothing is discarded until you actually start, and you can back
          out with <strong>Keep my paused session</strong>.
        </p>
        <p className="text-sm">
          From the moment you start, the ring is also a slow breathing pacer:
          four seconds growing, six seconds settling back. It runs for the whole
          session — through a pause and out the other side — and stops when time
          is up. Follow it if you want something to steady yourself against,
          ignore it the rest of the time; it never moves the clock or the
          buttons, and there is nothing to switch on. If your system asks for
          reduced motion, the ring simply holds still.
        </p>
        <p className="text-sm">
          <strong>Focus music</strong>: ten lo-fi tracks are bundled with the
          app, so nothing is streamed from anywhere else. Choose one under{" "}
          <strong>Focus timer → Focus sounds</strong> on the{" "}
          <Link href="/settings?from=help" className="underline">
            Settings
          </Link>{" "}
          page — each has a preview toggle so you can audition it without
          starting a session. During a session a small player gives you
          play/pause, previous/next, volume and progress, plus{" "}
          <strong>Shuffle</strong>. The playlist moves itself along when a track
          ends and only starts over once every track has played, so you should
          not hear the same thing twice in a row. It follows the timer: pausing
          pauses the music, resuming resumes it, and ending the session stops
          it. Turn on <strong>Pause music and timer together</strong> in
          settings and it works both ways round — the player&rsquo;s own pause
          button then stops your session too, and playing again resumes both.
        </p>
        <p className="text-sm">
          Also in <strong>Focus timer</strong> settings: four timer styles,{" "}
          <strong>Keep screen awake</strong>, an{" "}
          <strong>Alarm at time&rsquo;s-up</strong>, and{" "}
          <strong>Minimal / distraction-free</strong>, which strips the screen
          back to the countdown and its controls while the timer runs. Worth
          knowing: minimal mode also hides the music player mid-session — the
          music keeps playing, there is just nothing on screen to control it
          until you pause.
        </p>
      </section>

      <section className="space-y-2">
        <SectionHeading id="help-voice-settings" voice={voice} />
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
        <SectionHeading id="help-guests-ai-limits" voice={voice} />
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
