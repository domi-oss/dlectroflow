import { t } from "@/lib/strings";
import type { Voice } from "@/lib/strings";

// Deep-link targets for each section's "see all →" link (Library).
export const SEE_ALL = {
  singleTask: "/library?tab=plated",
  multiStep: "/library?tab=sorted",
  savedLater: "/library?tab=pantry",
} as const;

/** Sub-bucket heading: label + count badge + a "see all →" deep-link. */
export function SubHeader({
  label,
  count,
  seeAllHref,
  voice,
}: {
  label: string;
  count: number;
  seeAllHref: string;
  voice: Voice;
}) {
  return (
    <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
      {/* #40 Phase 3.4 — section labels carry the brand colour (AA text
          magenta, --primary). The count badge + see-all keep their own tones. */}
      <span className="text-primary">{label}</span>
      <span className="bg-secondary text-secondary-foreground rounded-full px-2 py-0.5 text-xs">
        {count}
      </span>
      <a
        href={seeAllHref}
        className="text-muted-foreground hover:text-foreground ml-auto inline-flex min-h-[44px] items-center text-xs font-normal"
      >
        {t("link.seeAll", voice)}
      </a>
    </div>
  );
}
