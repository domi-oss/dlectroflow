/**
 * Capture Prisma's client-level error log around a call.
 *
 * Extracted from `src/lib/db.integration.test.ts` when #158 gave the same proof
 * a second and third caller. It is the only way to observe the defect that #156
 * and #158 are about: `log: ["error"]` (src/lib/db.ts) makes Prisma print a
 * failed query the moment it fails, strictly BEFORE the exception reaches any
 * `catch`, so a fully handled unique-constraint race still emitted
 *
 *     prisma:error  Invalid `settings.upsert()` invocation:
 *                   Unique constraint failed on the fields: (`id`)
 *
 * (Prisma prints that with a `prisma.` prefix on the delegate. It is dropped
 * here because `scoping.harness.test.ts` scans every non-test source file for
 * that exact token and cannot tell a comment from a call — this file is a
 * helper, not a `.test.ts`, so it is in scope for the scan.)
 *
 * and got escalated as a production incident. A mock cannot show that — the
 * line comes from the real client talking to a real Postgres — so every user of
 * this helper is an `*.integration.test.ts`.
 *
 * Lives in `__tests__/` rather than beside one module because the property it
 * measures is cross-cutting: four unrelated files claim it (same reason
 * `scoping.harness.test.ts` sits here rather than next to a model).
 */

/**
 * Run `fn`, returning every `prisma:error` line Prisma printed while it ran.
 *
 * `log: ["error"]` is Prisma's *stdout* logger: it writes to `console.log`, one
 * argument, prefixed `prisma:error` — verified against @prisma/client 6.19, and
 * the reason this hooks `console.log` rather than the `console.error` you would
 * expect. Everything else is passed through, so a failing run still prints
 * whatever it was going to print.
 *
 * Not safe to nest or to run concurrently with itself: it swaps a global. Every
 * caller awaits one `fn` at a time, and the `finally` restores the original
 * even when `fn` throws.
 */
export async function prismaErrorsDuring(
  fn: () => Promise<void>,
): Promise<string[]> {
  const captured: string[] = [];
  const passThrough = console.log;
  console.log = (...args: unknown[]) => {
    const line = args.map(String).join(" ");
    if (line.startsWith("prisma:error")) captured.push(line);
    else passThrough(...args);
  };
  try {
    await fn();
  } finally {
    console.log = passThrough;
  }
  return captured;
}
