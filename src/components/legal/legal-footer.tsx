import Link from "next/link";
import { cn } from "@/lib/utils";
import { SOURCE_REPO_URL } from "@/lib/legal";

/**
 * The site-wide legal footer (#123) — Privacy, Terms, Source.
 *
 * Why it exists at all: Google's OAuth verification requires the privacy policy
 * to be *reachable from the app*, not merely to exist at a URL, so a page nobody
 * can navigate to fails review even when it renders perfectly. It is rendered on
 * the app shell (src/app/(app)/layout.tsx), the sign-in page and both legal
 * pages, which covers every surface a stranger can land on.
 *
 * The Source link is not decoration either: AGPL-3.0 §13 requires an instance
 * users interact with over a network to offer them the corresponding source, and
 * this is where this instance offers it.
 *
 * Deliberately quiet — `text-xs` on `text-muted-foreground`, one hairline rule,
 * centred — because it appears under every screen in the app and is legal
 * plumbing, not navigation anyone is looking for. Both are already-proven values
 * in this palette: `text-muted-foreground text-xs` is the size/colour pair
 * src/components/settings/people-panel.tsx uses on a surface the zero-tolerance
 * contrast gate (e2e/a11y/axe-helpers.ts) already scans in both themes.
 *
 * Not a client component: no state, no effects, so it renders directly inside
 * the Server-Component layouts.
 */
const LINKS = [
  { href: "/privacy", label: "Privacy", external: false },
  { href: "/terms", label: "Terms", external: false },
  { href: SOURCE_REPO_URL, label: "Source", external: true },
] as const;

// One shared link style. Mirrors src/components/nav/back-link.tsx so a footer
// link feels like every other quiet link in the app. `py-2` keeps the hit area
// comfortably past the 24px WCAG 2.2 AA minimum without making the bar tall.
const LINK_CLASS =
  "focus-visible:ring-ring hover:text-primary focus-visible:text-primary rounded px-1 py-2 outline-none hover:underline focus-visible:ring-2";

export function LegalFooter({ className }: { className?: string }) {
  return (
    <footer className={cn("border-t", className)}>
      {/* Labelled so a screen-reader user landing here by rotor knows what this
          group of three links is; "Legal" alone would not describe Source. */}
      <nav
        aria-label="Legal and source"
        className="text-muted-foreground mx-auto flex w-full max-w-3xl flex-wrap items-center justify-center gap-x-4 px-4 py-3 text-xs"
      >
        {/* All three open in a new tab, and all three are plain anchors —
            `next/link` has nothing to offer a navigation that leaves this tab.
            The previous rule was the opposite of this, and its stated reason was
            wrong: "every bit of state is persisted server-side" is not true of
            the text sitting in the capture bar, or of a note whose debounced
            save has not flushed yet. This footer renders under EVERY screen
            including the inbox, so an in-tab jump to the terms could destroy a
            thought someone was part-way through capturing — which in a
            brain-dump tool is the one loss with no undo.

            The cost the old comment identified is real and is paid below rather
            than avoided: a new tab is a change of context the user did not
            request (WCAG 3.2.5), so every link says so in its accessible name.
            Sighted users see the tab appear; a screen-reader user gets nothing
            unless it is in the name. */}
        {LINKS.map((link) => (
          <a
            key={link.href}
            href={link.href}
            target="_blank"
            // `noopener` is the load-bearing half — without it the opened
            // document holds a `window.opener` handle back into this one. Implied
            // by `target="_blank"` in current browsers; stated anyway, because it
            // costs one attribute and its absence fails silently.
            rel="noopener noreferrer"
            // An explicit label, NOT the visible text plus a leading space in an
            // `sr-only` span. That was tried first and computes as
            // "Privacy(opens in a new tab)" — one word — because accessible-name
            // computation collapses the whitespace that separated them. #44 hit
            // the identical fault on its note control ("Add notefor <task>"), so
            // this is the second time this exact shape has produced a mangled
            // name. Whitespace between an element's text and a hidden span does
            // not survive; an aria-label does.
            aria-label={`${link.label} (opens in a new tab)`}
            className={LINK_CLASS}
          >
            {link.label}
          </a>
        ))}
      </nav>
    </footer>
  );
}
