import Link from "next/link";
import { headers } from "next/headers";
import { prisma, getSettings } from "@/lib/db";
import { currentUser, currentWorkspaceId } from "@/lib/workspace";
import { identityFor } from "@/lib/identity";
import {
  clientIpHash,
  guestQuotaConfig,
  peekGuestAllowance,
} from "@/lib/guest-quota";
import { GuestIndicator } from "@/components/guest/guest-indicator";
import { VoiceProvider } from "@/components/voice-provider";
import { ReviewNudge } from "@/components/dashboard/review-nudge";
import { AppMenu } from "@/components/nav/app-menu";
import { AuthActions } from "@/components/nav/auth-actions";
import { QuickAccess } from "@/components/nav/quick-access";
import { BrandMark } from "@/components/brand/brand-mark";
import { LegalFooter } from "@/components/legal/legal-footer";
import { ThemeToggle } from "@/components/theme-toggle";
import { completionRootAttrs } from "@/lib/completion-style";
import { typefaceRootAttrs } from "@/lib/typeface";
import { type Voice } from "@/lib/strings";

export default async function AppLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // #35 Phase A: the guest banner is about being a GUEST, not about being the
  // owner. Those were the same question before accounts; now an invited member
  // is signed in but not an owner, and would otherwise be shown the sandbox
  // banner and a guest AI allowance for a workspace that is really theirs.
  //
  // #100: ONE identity resolution for the whole shell (the convention
  // /settings already follows). The header needs to say WHO, not just whether,
  // so the resolved account is kept rather than collapsed to a boolean — and
  // `identityFor` decides what of it may cross into a client component.
  const me = await currentUser();
  const signedIn = me !== null;
  const identity = me ? identityFor(me) : null;

  const wsId = await currentWorkspaceId();

  let guest: { remaining: number; quota: number; expiresAt: string } | null =
    null;
  if (!signedIn) {
    const ws = await prisma.workspace.findUnique({
      where: { id: wsId },
      select: { expiresAt: true },
    });
    const { quota } = guestQuotaConfig();
    const ipHash = clientIpHash(await headers());
    const remaining = ipHash
      ? (await peekGuestAllowance(ipHash)).remaining
      : quota;
    guest = {
      remaining,
      quota,
      expiresAt: (
        ws?.expiresAt ??
        // eslint-disable-next-line react-hooks/purity -- async Server Component: this runs once per request on the server, not in a compiler-memoised client render.
        new Date(Date.now() + 24 * 3600_000)
      ).toISOString(),
    };
  }

  // Read voice server-side; fall back to "plain" if row doesn't exist yet.
  const settings = await getSettings(wsId);
  const voice: Voice = settings.voice === "playful" ? "playful" : "plain";

  return (
    <div
      className="flex min-h-full flex-col"
      {...completionRootAttrs(settings)}
      {...typefaceRootAttrs(settings)}
    >
      {guest && (
        <GuestIndicator
          remaining={guest.remaining}
          quota={guest.quota}
          expiresAt={guest.expiresAt}
          voice={voice}
        />
      )}
      <header className="border-b">
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between px-4 py-3">
          <Link
            href="/"
            className="flex items-center gap-2 text-lg font-semibold tracking-tight"
          >
            {/* #13/#40 — app-icon brand mark; decorative (aria-hidden) so the
                link's accessible name stays "dlectroflow". */}
            <BrandMark className="h-6 w-6 shrink-0" />
            {/* #252 — the MARK alone below `sm`, the mark plus the wordmark above
                it. Measured, not guessed: at 360px the row has 328px of content
                width, and the wordmark is 89.6px of unbreakable single word at
                `text-lg` plus its 8px gap. Even before this change the bar
                measured 334.4px there and overflowed by 6.4 (by 28 with a handle
                long enough to hit its cap) — `MOBILE` (390) was the narrowest
                width anything in the suite asserted on, so nothing could see it.
                With two more 44px controls it overflowed by 78.4.

                `sr-only sm:not-sr-only` rather than `hidden sm:inline`: `display:
                none` would take the word out of the accessibility tree, and the
                mark is `aria-hidden`, so the home link would be left with NO
                accessible name at exactly the widths where it is the only way
                back. `sr-only` positions it absolutely instead, which also takes
                it out of the flex flow — so the gap collapses with it and the
                link measures 24px. */}
            <span className="sr-only sm:not-sr-only">dlectroflow</span>
          </Link>
          {/* `gap-1` below `sm`, the app's only breakpoint (see
              `section-nav.tsx`'s WIDE). Four gaps at 16px is 64px of a 328px
              budget — more than one whole control — and the cluster does not fit
              at 360px with them. Above `sm` there is room to spare, so the
              original spacing stands. */}
          <div className="text-muted-foreground flex items-center gap-1 text-sm sm:gap-4">
            {/* #252 — one-tap access to the two destinations that were behind
                the hamburger. FIRST in the cluster: these are things you came
                to press, and the three controls after them are about the app
                rather than about the work. Both gates are columns on the
                `settings` row already read above for the voice, so the pair
                costs no query — and `QuickAccess` is a server component, so it
                costs no client bundle either. */}
            <QuickAccess
              voice={voice}
              shoppingList={settings.shoppingList}
              focusQuickAccess={settings.focusQuickAccess}
            />
            {/* #49 — theme toggle lives in the header, immediately left of the
                sign-in / account action so it's always reachable (light +
                dark). It's a self-contained client control; it renders the
                same whether or not you are signed in.
                #103 — icon-only here: in a menu bar "Dark mode"/"Light mode"
                is dead weight, and the extra width crowded the bar at 390px.
                Settings > Appearance keeps the words (its default variant). */}
            <ThemeToggle variant="icon" />
            {/* #100 — the middle slot NAMES the account: a guest gets the
                "Sign in" link, a signed-in account gets its handle, which opens
                the identity popover that absorbed "Account" and "Sign out". So
                this cluster is three controls in both states, not five in one of
                them — the bar measured wider than a 390px viewport before. */}
            <AuthActions identity={identity} />
            {/* #199 — the shopping-list entry, off unless this workspace asked
                for it. `settings` is already read here for the voice, so the
                menu costs no extra query. Hiding the link is presentation: the
                gate that matters is `notFound()` on /shopping plus the same
                check in every shopping server action. */}
            <AppMenu voice={voice} shoppingList={settings.shoppingList} />
          </div>
        </div>
      </header>
      <div className="mx-auto w-full max-w-3xl flex-1 px-4 py-6">
        <VoiceProvider voice={voice}>
          <ReviewNudge
            notifyDailyReview={settings.notifyDailyReview}
            dailyReviewNudgeTime={settings.dailyReviewNudgeTime}
          />
          {children}
        </VoiceProvider>
      </div>
      {/* #123 — Google's OAuth verification requires the privacy policy to be
          reachable FROM the app, not merely to exist at a URL. One quiet footer
          on the shell covers every in-app route at once. Outside the
          VoiceProvider on purpose: legal links are not voiced copy. */}
      <LegalFooter />
    </div>
  );
}
