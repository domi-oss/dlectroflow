import { notFound } from "next/navigation";
import { prisma, getSettings } from "@/lib/db";
import { currentWorkspaceId } from "@/lib/workspace";
import { ShoppingList } from "@/components/shopping/shopping-list";
import { t, type Voice } from "@/lib/strings";

// DB-backed, always fresh.
export const dynamic = "force-dynamic";

/**
 * #199 — shopping-list mode's own destination.
 *
 * ## The gate is here, not only on the menu entry
 *
 * `Settings.shoppingList` is off by default, and this page refuses to render when
 * it is. Hiding the menu link is presentation: `/shopping` stays reachable by
 * typing the URL, following a bookmark, or a back button after the switch is
 * turned off — so a menu-only gate would make the switch decoration. The server
 * actions carry the same check, because a server action is a POST endpoint that
 * never loads this page.
 *
 * The gate is decided BEFORE the list is read, so a 404 does no query. Not an
 * optimisation — a page that fetched the rows it is about to refuse to show is the
 * shape somebody later "tidies" into rendering the data it already has.
 *
 * This is a feature switch, not an authorization boundary. Whose rows these are is
 * decided by the `workspaceId` filter, which is the invariant the scoping harness
 * polices; the switch decides whether the feature is running at all.
 *
 * ## Ordering is fixed here, not left to the database
 *
 * `[{ order: "asc" }, { id: "asc" }]` — the same tie-break `splitShoppingList`
 * applies on the client. Two concurrent adds can allocate the same `order`
 * (see `nextShoppingOrder`), and an unqualified sort would then let Postgres
 * return them in either sequence, so the list would silently reshuffle between
 * page loads.
 */
export default async function ShoppingPage() {
  const workspaceId = await currentWorkspaceId();
  const settings = await getSettings(workspaceId);
  if (!settings.shoppingList) notFound();

  const items = await prisma.shoppingItem.findMany({
    where: { workspaceId },
    orderBy: [{ order: "asc" }, { id: "asc" }],
  });
  const voice: Voice = settings.voice === "playful" ? "playful" : "plain";

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">{t("nav.shopping", voice)}</h1>
      <ShoppingList items={items} voice={voice} />
    </div>
  );
}
