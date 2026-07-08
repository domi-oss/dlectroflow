import Link from "next/link";
import { getSettings } from "@/lib/db";
import { currentWorkspaceId } from "@/lib/workspace";
import { t, type Voice } from "@/lib/strings";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const workspaceId = await currentWorkspaceId();
  const settings = await getSettings(workspaceId);
  const voice: Voice = settings.voice === "playful" ? "playful" : "plain";

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">{t("nav.settings", voice)}</h1>
      <p className="text-muted-foreground text-sm">This page is coming soon.</p>
      <Link href="/inbox" className="text-sm underline">
        {t("action.backToInbox", voice)}
      </Link>
    </div>
  );
}
