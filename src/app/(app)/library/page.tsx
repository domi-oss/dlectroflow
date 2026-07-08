import Link from "next/link";
import { getSettings } from "@/lib/db";
import { currentWorkspaceId } from "@/lib/workspace";
import { t, type Voice } from "@/lib/strings";

export const dynamic = "force-dynamic";

export default async function LibraryPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const workspaceId = await currentWorkspaceId();
  const [settings, { tab }] = await Promise.all([
    getSettings(workspaceId),
    searchParams,
  ]);
  const voice: Voice = settings.voice === "playful" ? "playful" : "plain";

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">{t("nav.everything", voice)}</h1>
      <p className="text-muted-foreground text-sm">
        {tab ? `The "${tab}" view is` : "This view is"} coming soon.
      </p>
      <Link href="/inbox" className="text-sm underline">
        {t("action.backToInbox", voice)}
      </Link>
    </div>
  );
}
