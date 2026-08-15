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
      {/* A `<div>`, not a `<header>`. `<header>` maps to the `banner` landmark
          unless it is inside `article`/`aside`/`main`/`nav`/`section`, and
          `(app)/layout.tsx:151` wraps `{children}` in a plain `<div>` — so there
          is no sectioning ancestor above this point and a `<header>` here
          resolved to a SECOND banner, beside the shell's own at `layout.tsx:83`.
          /help was the only `(app)` page with this shape. The `h1` is what names
          the page either way, so the element buys nothing back. */}
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">Help &amp; getting started</h1>
        <p className="text-muted-foreground text-sm">
          A quick tour of how dlectroflow works — capture, review, break down,
          focus, done.
        </p>
      </div>

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
          <strong>Save for later</strong> to take something you are not ready
          for out of the queue, so it stops asking. You can tune the tier
          thresholds under <strong>Aging &amp; reminder</strong> on the{" "}
          <Link href="/settings?from=help" className="underline">
            Settings
          </Link>{" "}
          page.
        </p>
        {/* The board can be rearranged and the page never said so, which left
            "put this back in Needs review" with no documented route.

            Both paths are named deliberately. The drag is a pointer gesture and
            the row's `Move to` control is its non-pointer equivalent — the two
            share one dispatcher, and that equivalence is what carries WCAG 2.1.1
            and 2.5.7 for this interaction. Describing only the drag would describe
            the app to whoever happens to be able to perform it. `Move to` is the
            control's real accessible name; the older nested "Move to…" ▾ entry
            went with #253, so the ellipsis form would name something absent. */}
        <p className="text-sm">
          Nothing is stuck where it landed. Drag a row onto another list to move
          it — or, for exactly the same result without dragging, use the
          row&rsquo;s <strong>Move to</strong> control and pick the list by
          name, which is also the way to do it from the keyboard. The lists are{" "}
          <strong>Needs review</strong>, <strong>Multi-step to-dos</strong>,{" "}
          <strong>Single-task to-dos</strong>, <strong>Saved for later</strong>{" "}
          and <strong>Completed</strong>, and a move is announced either way, so
          you are told which list an item left as well as where it arrived.
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
        {/* #89 — the pacer is RING-STYLE ONLY, and this paragraph used to read as
            though every session had it ("From the moment you start, the ring is
            also a slow breathing pacer … there is nothing to switch on").
            `timer-visual.tsx` reaches the breathing markup only in its `ring`
            branch — `digits`, `bar` and `mug` each return before it — so three of
            the four styles never breathe, and `resolveTimerStyle(null, voice)`
            resolves an unset style to `mug` on the playful voice. A reader who
            picked Bar, or who never picked anything on the playful voice, was
            being told about something their session cannot do. */}
        <p className="text-sm">
          The <strong>Ring</strong> timer style doubles as a slow breathing
          pacer: from the moment you start, four seconds growing, six seconds
          settling back. It runs for the whole session — through a pause and out
          the other side — and stops when time is up. Follow it if you want
          something to steady yourself against, ignore it the rest of the time;
          it never moves the clock or the buttons, and it needs no setting of
          its own. The other three timer styles do not breathe, so if you want
          it, pick <strong>Ring</strong> under{" "}
          <strong>Focus timer → Timer style</strong>. If your system asks for
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
          still plays. Music is <strong>on to start with</strong> — if you would
          rather work in silence, one switch turns it off:{" "}
          <strong>Focus timer → Focus sounds</strong> on the{" "}
          <Link href="/settings?from=help" className="underline">
            Settings
          </Link>{" "}
          page. That switch is the only music setting there, on purpose;{" "}
          <strong>which playlists and which track</strong> you pick from the
          player while a session is running, because that is a decision you make
          while listening rather than one to make in advance. During a session
          that player gives you play/pause, previous/next, volume and progress,
          plus <strong>Shuffle</strong>. The playlist moves itself along when a
          track ends and only starts over once every track has played, so you
          should not hear the same thing twice in a row. It follows the timer:
          pausing pauses the music, resuming resumes it, and ending the session
          stops it. Turn on <strong>Pause music and timer together</strong> in
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
        {/* #252 — the shortcut is ON for everyone, so the sentence people need is
            "how do I get rid of it", not "how do I get it". It also has to say
            that hiding the button leaves the timer where it was, because those
            two read identically from a checkbox. */}
        <p className="text-sm">
          The top bar carries a <strong>one-tap shortcut to the timer</strong>,
          so starting a session never costs a trip through the menu. It is on to
          start with; <strong>Focus timer → Shortcut in the header</strong>{" "}
          hides the button, and the focus timer stays in the menu either way.
        </p>
      </section>

      {/* The getting-started list above ends by promising the reader they will
          "earn points toward your streak" — a payoff whose address this page never
          gave. Library and Activity are two of the app menu's six default
          destinations (`app-menu.test.tsx:53-63` pins that list) and neither was
          named anywhere here.

          Library is described as a fuller VIEW, never as a destination work moves
          to (Duo review round 4, !356). `libraryBuckets` (`bucket.ts:255-260`)
          returns `base.singleTask`, `base.multiStep` and `base.savedLater` — the
          same arrays `bucketItems` hands the inbox, which renders all five of its
          lists on screen. Only `Done` differs, being uncapped where the inbox's
          `Completed` is `slice(0, 10)`. Two drafts got this wrong in the same way:
          "once something leaves the inbox it lives in Library" was wrong about all
          four tabs, and conceding the overlap for `Saved for later` alone was wrong
          about the other three. A reader who believes work moves house goes looking
          for where it went.

          Both are linked by their MENU labels rather than their routes, because
          those are the words on screen: `/dashboard` renders `nav.dashboard` →
          "Activity", so a reader sent to look for "Dashboard" finds nothing. */}
      <section className="space-y-2">
        <SectionHeading id="help-where-things-go" voice={voice} />
        <p className="text-sm">
          <Link href="/library" className="underline">
            Library
          </Link>{" "}
          gathers everything you have reviewed, under four tabs:{" "}
          <strong>Single-task</strong> and <strong>Multi-step</strong> for work
          in progress, <strong>Saved for later</strong> for anything parked, and{" "}
          <strong>Done</strong> for finished work. Nothing has moved house —
          these are the <strong>same lists</strong> the inbox page keeps below
          its review queue, so you can work from either. The one difference is{" "}
          <strong>Done</strong>: the inbox shows a short preview of your most
          recent completions, with a count of how many you finished today, while{" "}
          <strong>Done</strong> is the whole history. Opening a multi-step row
          expands its steps in place, so you can carry on without leaving the
          page.
        </p>
        <p className="text-sm">
          <Link href="/dashboard" className="underline">
            Activity
          </Link>{" "}
          is where the points and streaks land: what you earned today, your
          current streak, your best streaks, and <strong>badges</strong> that
          fill in as you reach them. It also holds the{" "}
          <strong>end-of-day round-up</strong> — a short recap of the day
          written for you when your workday ends, which you can also trigger
          early to see what it looks like.
        </p>
        {/* Duo review, !356 — the round-up's settings are SPLIT across two pages,
            and this used to say they "are on that page rather than in Settings",
            full stop. `workdayEndTime` and `roundupEmailEnabled` are on the Activity
            page; `notifyRoundup` — whether it also raises a desktop notification —
            is Settings → Notifications, whose hint says the in-app recap shows
            either way. Telling a reader Settings has nothing to do with the round-up
            sends them hunting in the wrong place for the toggle they actually want. */}
        <p className="text-sm">
          Its settings sit in two places, which is worth knowing before you go
          looking. <strong>When your workday ends</strong> and{" "}
          <strong>whether it is emailed to you</strong> are on the Activity page
          itself, tucked under the round-up. Whether it also raises a{" "}
          <strong>desktop notification</strong> is a separate switch, under{" "}
          <strong>Notifications</strong> on the{" "}
          <Link href="/settings?from=help" className="underline">
            Settings
          </Link>{" "}
          page — turn that off and the recap still appears on the page, it just
          does not come and find you.
        </p>
      </section>

      {/* #199 — shopping-list mode. `Settings.shoppingList` is `@default(false)`
          and `/shopping` answers `notFound()` while it is off, so this section has
          to lead with the switch: the feature is not merely undocumented without
          it, it is unreachable. Its own section rather than a line inside
          "Voice & settings", matching why `settings-shopping` is its own section —
          a feature switch filed under a heading that does not name it is a feature
          nobody finds. */}
      <section className="space-y-2">
        <SectionHeading id="help-shopping-list" voice={voice} />
        <p className="text-sm">
          <strong>Off until you turn it on.</strong> Tick{" "}
          <strong>Show the shopping list</strong> under{" "}
          <strong>Shopping list</strong> on the{" "}
          <Link href="/settings?from=help" className="underline">
            Settings
          </Link>{" "}
          page and a <strong>Shopping list</strong> entry appears in the menu,
          alongside a trolley button in the top bar. Turning it back off hides
          the list <strong>without deleting it</strong> — everything is still
          there if you switch it on again.
        </p>
        <p className="text-sm">
          It is deliberately a plain list, not a kind of task: no estimates, no
          steps, nothing lands in your calendar, and ticking something off does
          not touch your streak. Add a line, tick it, rename it, or delete it.
          While the list has anything on it the inbox shows a one-line reminder
          of how many items are waiting, which you can dismiss.
        </p>
        {/* Duo review, !356 — `Saved for later` names two unrelated things: the
            Library tab of `BrainDumpItem`s, and this list's own
            `ShoppingItem.savedForLater`, a separate model. Because this section
            insists the shopping list is "not a kind of task", borrowing the tab's
            name silently implied shopping items enter the task pipeline. The label
            is the app's and cannot be renamed from here, so the page disowns the
            overlap instead of glossing it. */}
        <p className="text-sm">
          The list has its own <strong>Saved for later</strong> shelf for things
          you only buy occasionally. It shares a name with the{" "}
          <Link href="/library" className="underline">
            Library
          </Link>{" "}
          tab and has <strong>nothing to do with it</strong> — the two are
          separate, and a shopping item never becomes a task or appears as an
          inbox row. (The reminder above is a count of the list, not the items
          themselves.) Nothing comes back off that shelf on its own; you pull an
          item up when you want it again.
        </p>
      </section>

      <section className="space-y-2">
        <SectionHeading id="help-voice-settings" voice={voice} />
        <p className="text-sm">
          Switch between the calm <strong>Plain</strong> voice and the playful
          snack-themed voice, set your freshness thresholds, choose your{" "}
          <strong>notifications</strong>, adjust the <strong>appearance</strong>
          , connect your <strong>integrations</strong>, and set{" "}
          <strong>the name the app calls you</strong> on the{" "}
          <Link href="/settings?from=help" className="underline">
            Settings
          </Link>{" "}
          page.
        </p>
        {/* #40 — the Typeface radios include two legibility aids, and this page
            offered nothing to the reader most likely to be looking for them.
            Someone who cannot comfortably read the app is exactly who opens a help
            page, so the two faces are named: the NAME is the search term. */}
        <p className="text-sm">
          <strong>Appearance</strong> covers the colour scheme, how completed
          items are struck through and ticked, and the <strong>typeface</strong>{" "}
          the whole app uses. The scheme has three settings and starts on{" "}
          <strong>Follow my system</strong>, so by default the app matches your
          device — including any automatic day/night schedule it already has,
          which is why there is no separate timer for it here.{" "}
          <strong>Light</strong> and <strong>Dark</strong> override that.
        </p>
        <p className="text-sm">
          Two of the four typefaces are there to make reading easier —{" "}
          <strong>Atkinson Hyperlegible</strong> and{" "}
          <strong>OpenDyslexic</strong> — so if the default is hard going, that
          is the setting to try first.
        </p>
        {/* The section is called `Notifications`, not "reminders", and every toggle
            in it is inert until the browser grants permission. A user can tick all
            three, be told nothing, and receive nothing — so the precondition is
            stated here rather than left to be inferred from silence. */}
        <p className="text-sm">
          <strong>Notifications</strong> is where the round-up, aging reminders
          and the daily review nudge are switched on or off, and where the
          nudge&rsquo;s time is set. They are desktop notifications, so{" "}
          <strong>your browser has to grant permission first</strong> — until it
          does, the switches save but nothing arrives. The page offers you that
          permission prompt when it can.
        </p>
        {/* Two integrations existed and neither was mentioned. The feed URL is a
            bearer capability — anyone holding it reads the feed unauthenticated —
            and this page documents data rights two sections down, so the caveat
            `calendar-feed.tsx` puts on screen is carried here too rather than being
            met only after the URL has been pasted somewhere. */}
        <p className="text-sm">
          <strong>Integrations</strong> holds two, and both are yours alone
          rather than the instance&rsquo;s: connect{" "}
          <strong>Google Tasks</strong> to schedule your steps into your own
          account, and create a <strong>calendar feed</strong> your calendar app
          can subscribe to. Treat that feed&rsquo;s address like a password —
          anyone who has it can read your step titles and times{" "}
          <strong>without signing in</strong>, so regenerate it if it gets out.
          You can turn either off again, and a single task can be added to a
          calendar as a one-off file without connecting anything.
        </p>
        {/* #252 — the header used to greet people by their provider username,
            which is nobody's name. Says where the field is, and that it changes
            nothing about signing in — a name field on an account page reads as a
            login by default. */}
        <p className="text-sm">
          The corner of the top bar shows your{" "}
          <strong>provider username</strong> until you tell it otherwise.{" "}
          <strong>Account → Your name</strong> sets what it calls you instead;
          it saves as you type, changes nothing about how you sign in, and
          emptying it goes back to the username.
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
