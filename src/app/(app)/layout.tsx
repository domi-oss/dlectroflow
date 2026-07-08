import Link from "next/link";
import { headers } from "next/headers";
import { prisma, getSettings } from "@/lib/db";
import { isOwnerRequest, currentWorkspaceId } from "@/lib/workspace";
import { clientIpHash, guestQuotaConfig, peekGuestAllowance } from "@/lib/guest-quota";
import { GuestIndicator } from "@/components/guest/guest-indicator";
import { VoiceProvider } from "@/components/voice-provider";
import { t, type Voice } from "@/lib/strings";

export default async function AppLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const owner = await isOwnerRequest();

  const wsId = await currentWorkspaceId();

  let guest: { remaining: number; quota: number; expiresAt: string } | null = null;
  if (!owner) {
    const ws = await prisma.workspace.findUnique({ where: { id: wsId }, select: { expiresAt: true } });
    const { quota } = guestQuotaConfig();
    const ipHash = clientIpHash(await headers());
    const remaining = ipHash ? (await peekGuestAllowance(ipHash)).remaining : quota;
    guest = {
      remaining,
      quota,
      expiresAt: (ws?.expiresAt ?? new Date(Date.now() + 24 * 3600_000)).toISOString(),
    };
  }

  // Read voice server-side; fall back to "plain" if row doesn't exist yet.
  const settings = await getSettings(wsId);
  const voice: Voice = settings.voice === "playful" ? "playful" : "plain";

  return (
    <div className="flex min-h-full flex-col">
      {guest && (
        <GuestIndicator remaining={guest.remaining} quota={guest.quota} expiresAt={guest.expiresAt} />
      )}
      <header className="border-b">
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between px-4 py-3">
          <Link href="/inbox" className="text-lg font-semibold tracking-tight">
            dlectroflow
          </Link>
          <nav className="text-muted-foreground flex items-center gap-4 text-sm">
            <Link href="/inbox" className="hover:text-foreground transition-colors">
              {t("nav.inbox", voice)}
            </Link>
            <Link href="/dashboard" className="hover:text-foreground transition-colors">
              {t("nav.dashboard", voice)}
            </Link>
            {owner ? (
              <a href="/api/auth/logout" className="text-xs text-muted-foreground">Sign out</a>
            ) : (
              <a href="/login" className="text-xs text-muted-foreground">Owner sign in</a>
            )}
          </nav>
        </div>
      </header>
      <div className="mx-auto w-full max-w-3xl flex-1 px-4 py-6">
        <VoiceProvider voice={voice}>{children}</VoiceProvider>
      </div>
    </div>
  );
}
