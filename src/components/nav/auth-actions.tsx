import Link from "next/link";

/**
 * The header's authentication affordance (#35 Phase A).
 *
 * Before accounts, "signed in" and "is the owner" were the same thing, so this
 * read "Owner sign in". Sign-in is invite-only now but any invited member can
 * use it, so the label is simply "Sign in" — and once signed in it flips to
 * "Account", deep-linking to the Account group the design puts at the top of
 * /settings. That group itself lands in Phase C; until then the link resolves
 * to /settings and the fragment is inert.
 *
 * A fragment rather than a wrapper element, so the header's flex row stays flat
 * and the theme toggle keeps sitting immediately left of the first action.
 */
export function AuthActions({ signedIn }: { signedIn: boolean }) {
  const linkClass =
    "text-xs text-muted-foreground hover:underline focus-visible:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background rounded-sm";

  if (!signedIn) {
    return (
      <a href="/login" className={linkClass}>
        Sign in
      </a>
    );
  }

  return (
    <>
      <Link href="/settings#account" className={linkClass}>
        Account
      </Link>
      {/* Logout is a state change → POST-only (CSRF-safe), so it's a small
          form/button rather than a GET link. See #21 (P5 batch B). */}
      <form action="/api/auth/logout" method="post" className="flex">
        <button type="submit" className={linkClass}>
          Sign out
        </button>
      </form>
    </>
  );
}
