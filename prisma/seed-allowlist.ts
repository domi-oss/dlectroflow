/**
 * Owner-allowlist seed (#35 Phase A).
 *
 * The accounts migration makes sign-in invite-only. Without a seeded invitation
 * the owner is locked out of their own instance the moment Phase A deploys, so
 * this turns the `OWNER_ALLOWLIST` env var — the list that used to BE the auth
 * check — into `Allowlist` rows carrying `role = "owner"`.
 *
 * Why a script and not SQL inside the migration: the plan offered a Postgres GUC
 * (`current_setting('app.owner_allowlist', true)`), but nothing in this deploy
 * path ever sets that GUC. The `migrate` initContainer runs a bare
 * `npx prisma migrate deploy` with only `DATABASE_URL` in its environment (see
 * charts/dlectroflow/templates/deployment.yaml), and `prisma migrate deploy` has
 * no hook to issue a `SET` first. `current_setting(..., true)` returns NULL when
 * unset, `string_to_array(NULL, ',')` is NULL, and `unnest(NULL)` yields zero
 * rows — so the migration would have seeded NOTHING, silently, and the lockout
 * would only show up when the owner tried to sign in. A script that reads the
 * env var the chart already mounts is the version that actually runs.
 *
 * How it runs: a `seed-allowlist` initContainer, after `migrate` and before the
 * app container accepts traffic — i.e. before any sign-in can be attempted.
 * Idempotent, so every deploy re-asserts it.
 *
 * Self-contained on purpose, exactly like prisma/seed.ts and
 * prisma/scheduled-purge.ts: the standalone production image carries only
 * prisma/ plus traced node_modules, with no src/ and no `@/` path alias.
 */
import { PrismaClient } from "@prisma/client";

/** Marks rows this script owns, so a human-added invite is never mistaken for one. */
export const OWNER_SEED_NOTE = "seeded from OWNER_ALLOWLIST";

/**
 * Split the comma-separated env var into normalized identities.
 *
 * Lowercased and trimmed to match how `AuthProvider.fetchProfile` normalizes an
 * incoming profile — the two have to agree or the invite never matches. Empty
 * entries are dropped so a trailing comma cannot create a blank invitation that
 * a profile with no username would match.
 */
export function parseOwnerAllowlist(raw: string | undefined): string[] {
  const seen = new Set<string>();
  for (const part of (raw ?? "").split(",")) {
    const v = part.trim().toLowerCase();
    if (v) seen.add(v);
  }
  return [...seen];
}

// The minimal Prisma surface this seed touches, so the exported function is
// trivially unit-testable with a fake client (mirrors prisma/seed.ts).
export type AllowlistSeedClient = {
  allowlist: {
    upsert(args: unknown): Promise<unknown>;
  };
};

/**
 * Ensure an owner invitation exists for every identity in the list.
 *
 * `update` re-asserts `role` only. Re-running must never touch `claimedById` or
 * `claimedAt` — the owner's invitation is claimed the first time they sign in,
 * and clearing that would hand their invite to whoever asked next. A row that
 * was deleted entirely IS recreated, which is intended: `OWNER_ALLOWLIST` is the
 * deploy-time source of truth for who owns the instance, so an identity is
 * retired by removing it from the env var, not from the table.
 */
export async function seedOwnerAllowlist(
  db: AllowlistSeedClient,
  provider: string,
  identities: readonly string[],
): Promise<number> {
  for (const identity of identities) {
    await db.allowlist.upsert({
      where: { provider_identity: { provider, identity } },
      create: {
        provider,
        identity,
        role: "owner",
        note: OWNER_SEED_NOTE,
      },
      update: { role: "owner" },
    });
  }
  return identities.length;
}

/**
 * CLI entrypoint (`npm run seed:allowlist`, and the chart's initContainer).
 *
 * Exits non-zero on a real database failure so the deploy surfaces it, but exits
 * 0 on an empty `OWNER_ALLOWLIST`: the production boot guard already refuses to
 * start without it (src/lib/auth/config.ts), and hard-failing here would make
 * local dev and review apps undeployable for a value they legitimately omit.
 */
async function main(): Promise<void> {
  const provider = process.env.AUTH_PROVIDER ?? "gitlab";
  const identities = parseOwnerAllowlist(process.env.OWNER_ALLOWLIST);
  if (identities.length === 0) {
    console.warn(
      "[seed-allowlist] OWNER_ALLOWLIST is empty — no owner invitation seeded. Nobody will be able to sign in to this instance.",
    );
    return;
  }

  const prisma = new PrismaClient();
  try {
    const n = await seedOwnerAllowlist(prisma, provider, identities);
    // Log the COUNT, not the identities: an identity is a username or an email.
    console.log(
      JSON.stringify({
        tag: "seed_allowlist",
        provider,
        ownerInvites: n,
      }),
    );
  } finally {
    await prisma.$disconnect();
  }
}

// Only run when invoked directly (tsx/node), not when imported by tests.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(
        JSON.stringify({ tag: "seed_allowlist_error", error: String(e) }),
      );
      process.exit(1);
    });
}
