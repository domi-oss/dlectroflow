import { LEGAL_EFFECTIVE_DATE, formatEffectiveDate } from "@/lib/legal";
import { LegalFooter } from "./legal-footer";

/**
 * The shell both legal pages share (#123): title, effective date, contents,
 * body, footer.
 *
 * It exists so /privacy and /terms cannot drift apart in structure — a reader
 * comparing the two, or a reviewer checking them, should not have to work out
 * whether a difference is deliberate. It is not a route-group layout because
 * both pages sit OUTSIDE `(app)` deliberately (no session, no app chrome), and a
 * layout would then need its own route group just for two files.
 *
 * Typography follows the app's existing scale rather than inventing a prose
 * theme: `text-2xl font-semibold` h1, `text-lg font-semibold` h2,
 * `text-sm font-semibold` h3, `text-sm` body, `space-y-8` between sections —
 * the same values src/app/(app)/help/page.tsx and the settings sections use.
 *
 * Long-form legal text still has to be READABLE, which for this audience means
 * short paragraphs, a real heading hierarchy, and a contents list you can jump
 * from. `max-w-2xl` (narrower than the app's `max-w-3xl` shell) keeps the
 * measure near 70–80 characters, which is the readable range for continuous
 * prose; the app shell is wider because it holds lists and controls, not essays.
 */

/** One jumpable section: the `id` its heading carries and the title shown. */
export type LegalSectionSpec = {
  readonly id: string;
  readonly title: string;
};

/**
 * Resolve a section by id, so a page names each section ONCE (in its `SECTIONS`
 * array) and both the contents nav and the heading read from that one place.
 *
 * The `S[number]["id"]` parameter type is the point: with `SECTIONS` declared
 * `as const`, a mistyped id is a compile error rather than a heading whose
 * contents-list entry silently links nowhere. The runtime throw covers the case
 * where `as const` was forgotten and the type widened to `string`.
 */
export function sectionPicker<S extends readonly LegalSectionSpec[]>(
  sections: S,
) {
  return (id: S[number]["id"]): LegalSectionSpec => {
    const found = sections.find((section) => section.id === id);
    if (!found) throw new Error(`Unknown legal section id: ${id}`);
    return found;
  };
}

/**
 * One section of a legal document.
 *
 * The `h2` is the fragment target and is programmatically focusable
 * (`tabIndex={-1}`) — the convention src/components/nav/section-heading.tsx
 * established: a fragment jump then moves real focus to the heading instead of
 * leaving a keyboard or screen-reader user stranded at the top of the document.
 * It stays out of the tab order.
 */
export function LegalSection({
  id,
  title,
  children,
}: {
  readonly id: string;
  readonly title: string;
  readonly children: React.ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="space-y-2">
      <h2
        id={id}
        tabIndex={-1}
        className="focus-visible:ring-ring focus-visible:ring-offset-background scroll-mt-4 rounded-sm text-lg font-semibold outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
      >
        {title}
      </h2>
      {children}
    </section>
  );
}

/** A sub-heading inside a section. Matches the app's h3 scale. */
export function LegalSubheading({
  children,
}: {
  readonly children: React.ReactNode;
}) {
  return <h3 className="pt-1 text-sm font-semibold">{children}</h3>;
}

export function LegalPage({
  title,
  summary,
  sections,
  children,
}: {
  readonly title: string;
  /**
   * The "short version" — the honest gist, above the contents. Not a substitute
   * for the text (each page says so in its own words), but the difference
   * between a document that gets read and one that gets scrolled past.
   */
  readonly summary: React.ReactNode;
  readonly sections: readonly LegalSectionSpec[];
  readonly children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-full flex-col">
      <main className="mx-auto w-full max-w-2xl flex-1 space-y-8 px-4 py-8">
        <header className="space-y-2">
          <h1 className="text-2xl font-semibold">{title}</h1>
          {/* A `<time>` element, so the date is machine-readable as well as
              human-readable — it is the version identifier for this document,
              and the one field a reader uses to tell whether the text changed
              since they last agreed to it. */}
          <p className="text-muted-foreground text-sm">
            Effective{" "}
            <time dateTime={LEGAL_EFFECTIVE_DATE}>{formatEffectiveDate()}</time>
          </p>
        </header>

        <div className="space-y-2 text-sm">{summary}</div>

        <nav aria-labelledby="legal-contents" className="space-y-2">
          <h2 id="legal-contents" className="text-lg font-semibold">
            On this page
          </h2>
          <ol className="text-muted-foreground ml-5 list-decimal space-y-1 text-sm">
            {sections.map((section) => (
              <li key={section.id}>
                <a
                  href={`#${section.id}`}
                  className="focus-visible:ring-ring hover:text-primary focus-visible:text-primary rounded outline-none hover:underline focus-visible:ring-2"
                >
                  {section.title}
                </a>
              </li>
            ))}
          </ol>
        </nav>

        <div className="space-y-8">{children}</div>
      </main>
      <LegalFooter />
    </div>
  );
}
