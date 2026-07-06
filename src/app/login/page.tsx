export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-6 p-8 text-center">
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
        <p className="text-sm text-red-500">Sign-in failed. Please try again.</p>
      ) : null}
      <a
        href="/api/auth/gitlab/start"
        className="rounded-md bg-foreground px-4 py-2 text-background"
      >
        Sign in with GitLab
      </a>
    </main>
  );
}
