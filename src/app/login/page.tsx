import { LegalFooter } from "@/components/legal/legal-footer";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  return (
    // #123 — `flex-1` rather than `min-h-screen`: the sign-in card still fills
    // the viewport (html is h-full, body is `min-h-full flex flex-col`, the
    // pattern src/app/(app)/layout.tsx uses), but the legal footer below now sits
    // at the bottom of the screen instead of being pushed off it.
    <>
      <main className="mx-auto flex max-w-md flex-1 flex-col items-center justify-center gap-6 p-8 text-center">
        <h1 className="text-2xl font-semibold">Owner sign-in</h1>
        <p className="text-sm text-muted-foreground">
          This unlocks the private owner workspace. Everyone else can keep using
          the app as a guest.
        </p>
        {error === "not_authorized" ? (
          <p className="text-sm text-red-500">
            That account isn&apos;t the owner of this instance.
          </p>
        ) : error ? (
          <p className="text-sm text-red-500">
            Sign-in failed. Please try again.
          </p>
        ) : null}
        <a
          href="/api/auth/gitlab/start"
          className="rounded-md bg-foreground px-4 py-2 text-background"
        >
          Sign in with GitLab
        </a>
      </main>
      {/* Reachable from the sign-in page too: this is the one screen a visitor
          can be sent to before they have used anything, so it is where they are
          most likely to want to read the terms first. */}
      <LegalFooter />
    </>
  );
}
