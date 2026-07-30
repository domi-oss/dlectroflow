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
            dlectroflow
          </Link>
          <div className="text-muted-foreground flex items-center gap-4 text-sm">
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
            <AppMenu voice={voice} />
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
