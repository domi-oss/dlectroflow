import Link from "next/link";
import { t, type Voice } from "@/lib/strings";

/**
 * The one canonical "back to inbox" link. Renders a leading ← affordance plus
 * the voice-aware `action.backToInbox` copy ("Back to inbox" / "🍳 Back to
 * inbox") with a single shared className, so every page's back-nav looks and
 * reads the same. (Owner-reported inconsistency: the Activity dashboard bypassed
 * the voice system with a hardcoded lowercase "← inbox", and other pages each
 * rolled their own arrow/label/class recipe.)
 *
 * Deliberately NOT a `"use client"` module: it has no state, effects, or
 * browser APIs, so it renders directly in Server Components (dashboard,
 * settings, library, help) and, when imported into a Client Component
 * (breakdown-chat), is simply bundled alongside it — see
 * node_modules/next/dist/docs/01-app/01-getting-started/05-server-and-client-components.md
 * ("all of its imports and the components it directly renders are included in
 * the client bundle").
 *
 * Scope note: this is for PLAIN back-to-inbox nav only. It intentionally does
 * not replace the task page's origin-aware back link (which can point back to
 * the Library via a whitelist-guarded `?from=`), the focus flow's generic
 * "← Back" affordance, or forward CTAs like "Plan tomorrow →".
 */
export function BackToInbox({ voice }: { voice: Voice }) {
  return (
    <Link
      href="/inbox"
      className="text-muted-foreground inline-block text-sm hover:underline"
    >
      ← {t("action.backToInbox", voice)}
    </Link>
  );
}
