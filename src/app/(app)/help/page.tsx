import Link from "next/link";
import { getSettings } from "@/lib/db";
import { currentWorkspaceId } from "@/lib/workspace";
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
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">Help &amp; getting started</h1>
        <p className="text-muted-foreground text-sm">
          A quick tour of how dlectroflow works — capture, review, break down,
          focus, done.
        </p>
      </header>

      {/* #72 — the page map. Sticky so it stays reachable on a long scroll.
          #131 — and the way OUT rides with it. It is the page's only back
          control: because the bar is `sticky top-0` it is on screen at the top
          too, so the separate copy that used to sit above this heading was a
          duplicate of the same destination rather than extra reach. */}
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
        {/* #142 — the app navigates ON ITS OWN five seconds after a step is
            completed, which is the one thing on this page a reader cannot
            discover any other way: they meet it as the app moving without them.
            Both escapes are named, Escape included — it is the only one a
            screen-reader user can reach inside five seconds (WCAG 2.2.1), and
            an escape nobody has been told about is not one. */}
        <p className="text-sm">
          <strong>Finishing a step moves you on by itself.</strong> Inside a
          task with several steps, completing one counts down{" "}
          <strong>five seconds</strong> and then opens the next step — on its{" "}
          <strong>start screen</strong>, so you still choose a length and press
          Start. It <strong>does not start the timer</strong> for you. Press{" "}
          <strong>Go now</strong> to skip the wait, or{" "}
          <strong>Stay here</strong> to stop the countdown and stay on the
          finished step; <kbd>Escape</kbd> stops it too, from wherever your
          keyboard happens to be, so you never have to find a button inside five
          seconds. The countdown also pauses while the panel has keyboard focus,
          and <strong>Done for now</strong> leaves the run altogether.
        </p>
        <p className="text-sm">
          Finishing a whole <em>multi-step</em> task never moves you on by
          itself — that finish deserves a pause, so the next task is offered
          rather than taken. <strong>Hyper focus mode</strong> is what extends
          the same countdown to <em>single-task</em> to-dos, chaining one
          straight into the next. It is <strong>off by default</strong>, it
          covers single-task to-dos only (steps inside a task are not affected
          by it), and you turn it on or off on the{" "}
          <Link href="/focus" className="underline">
            Focus
          </Link>{" "}
          page — or by accepting the offer that appears when you run out of
          steps. It is remembered per browser rather than per account, so your
          phone and your laptop can be in different modes.
        </p>
        {/* #61 — this used to say "nothing is streamed from anywhere else",
            which stopped being true the moment a catalog store became
            configurable. It is a privacy claim, so the correction keeps BOTH
            halves: an operator can serve more tracks, and the browser still
            never contacts that store. `default-src 'self'` with `media-src`
            unset is what makes the second half true, and
            src/lib/security-headers.test.ts fails the build on any relaxation. */}
        <p className="text-sm">
          <strong>Focus music</strong>: ten lo-fi tracks are bundled with the
          app, so a session always has something to play — even offline, and
          even on a brand-new install. Whoever runs your instance can add{" "}
          <strong>more tracks</strong> from a store they run themselves, which
          is switched off unless they set it up. Either way{" "}
          <strong>your browser never contacts that store</strong>: the app
          fetches the audio itself and serves it from its own address, so
          listening never puts you in touch with anywhere else. If that store is
          missing or having a bad day you get the bundled ten and the music
          still plays. Choose a track under{" "}
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

      {/* #129 / #153 — the two controls a person needs when they want OUT.
          Neither is a feature you go looking for in a tour, and both are rights
          rather than conveniences (UK GDPR Art. 15/20 access and portability,
          Art. 17 erasure), so they get their own named section rather than a
          line inside "Voice & settings". Worded against what the app actually
          does, including the part that is not automatic — /privacy has said the
          same since #123 and the delete dialog says it too. */}
      <section className="space-y-2">
        <SectionHeading id="help-your-data" voice={voice} />
        {/* The Account section is filtered out of Settings for a caller with no
            account of their own (`me != null` in (app)/settings/page.tsx), so
            saying "it is on the Settings page" full stop would send a guest
            hunting for a control that is not rendered for them. */}
        <p className="text-sm">
          Both controls below live under <strong>Account</strong> on the{" "}
          <Link href="/settings?from=help" className="underline">
            Settings
          </Link>{" "}
          page. That section appears once you have{" "}
          <strong>an account of your own</strong> — a guest sandbox does not, so
          it is not shown there.
        </p>
        <p className="text-sm">
          <strong>Take a copy with you.</strong>{" "}
          <strong>Download my data (.zip)</strong> builds one archive of
          everything in this account: your tasks and their steps, your
          brain-dump inbox, the coaching conversations, your settings, and your
          scheduled work as a calendar file. The same data is written several
          ways so you are not stuck with one tool — a Markdown file you can read
          anywhere, CSVs for a spreadsheet, and a complete JSON copy. A README
          inside explains each file. Two things are deliberately left out: your{" "}
          <strong>Google connection</strong> and any <strong>API key</strong>{" "}
          you have stored are never exported.
        </p>
        <p className="text-sm">
          <strong>Delete your account.</strong>{" "}
          <strong>Delete my account</strong> opens a confirmation you have to{" "}
          <strong>type the word</strong> <kbd>delete</kbd> into, because this is
          not something to do by reflex. When it goes through you are{" "}
          <strong>signed out</strong> and cannot sign back in, and your Google
          Tasks connection is removed here — nothing inside your Google account
          is deleted. Your tasks, steps, notes and settings are then held for a
          short window so an accident can be undone: ask whoever runs the
          instance within it. To be straight about a gap: that final removal is
          done by hand today, not by a scheduled job. The confirmation itself
          names the exact number of days, and the{" "}
          <Link href="/privacy" className="underline">
            Privacy Policy
          </Link>{" "}
          covers backups, which are deleted on their own schedule.
        </p>
        <p className="text-sm">
          If you are the instance owner, the delete control is not there: yours
          is the only account that can manage the instance, so shutting it down
          is a deployment job rather than a settings one.
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
