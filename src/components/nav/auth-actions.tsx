import { AccountMenu } from "@/components/nav/account-menu";
import type { AccountIdentity } from "@/lib/identity";

/**
 * The header's authentication affordance (#35 Phase A, #100).
 *
 * Before accounts, "signed in" and "is the owner" were the same thing, so this
 * read "Owner sign in". Sign-in is invite-only now but any invited member can
 * use it, so the guest label is simply "Sign in".
 *
 * #100 replaced the signed-in half. It used to be the anonymous word "Account"
 * plus a "Sign out" button — and not one of them said WHICH account, which is how
 * signing in with the second of two GitLab accounts produced an empty workspace
 * with nothing on screen to explain it. The handle is now the visible control,
 * and it opens the identity popover that holds the provider, the role, Account
 * settings and Sign out (see account-menu.tsx for the design call, and for why it
 * is a popover rather than a sixth item in the bar).
 *
 * `identity` is `null` for a guest — not a boolean flag, so a signed-in header
 * cannot be rendered without the identity it is supposed to be showing. It is
 * resolved by the layout from `currentUser()`, i.e. from the signed cookie and
 * the account row, never from anything a client supplied.
 *
 * Each branch contributes exactly ONE element to the header's flex row, so the
 * theme toggle keeps sitting immediately left of it in either state.
 */
export function AuthActions({
  identity,
}: {
  identity: AccountIdentity | null;
}) {
  if (!identity) {
    return (
      <a
        href="/login"
        className="text-xs text-muted-foreground hover:underline focus-visible:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background rounded-sm"
      >
        Sign in
      </a>
    );
  }

  return <AccountMenu identity={identity} />;
}
