/** CronJob entrypoint: purge expired guest workspaces + stale guest counters.
 * Exits non-zero on failure so the CronJob surfaces errors. */
import { purgeExpiredGuests, purgeStaleGuestCounters } from "../src/lib/purge";

async function main() {
  let guestsPurged = 0;
  // purgeExpiredGuests is bounded (25/call); loop until drained (cap iterations).
  for (let i = 0; i < 200; i++) {
    const n = await purgeExpiredGuests();
    guestsPurged += n;
    if (n === 0) break;
  }
  const counters = await purgeStaleGuestCounters();
  console.log(JSON.stringify({ tag: "scheduled_purge", guestsPurged, ...counters }));
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
