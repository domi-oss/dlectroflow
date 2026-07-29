/**
 * Which title syntax to speak (#104).
 *
 * Reclaim syncs EXCLUSIVELY from its own `🗓 Reclaim` list — "any other tasks in
 * other lists will not be synced" — so the list we found already tells us
 * whether a Reclaim is listening. That makes the right encoder detectable with
 * zero configuration for either audience, which is the whole point: the owner
 * gets the parameters, a self-hoster with a plain list gets a clean title.
 */
import { encodeReclaim, type EncodeArgs } from "./encode-reclaim";
import { encodePlain, type EncodedTask } from "./encode-plain";

export type Encoder = (a: EncodeArgs) => EncodedTask;

export function pickEncoder(listTitle: string): Encoder {
  const override = (process.env.SCHEDULING_SYNTAX || "").toLowerCase();
  if (override === "plain") return encodePlain;
  if (override === "reclaim") return encodeReclaim;
  return listTitle.toLowerCase().includes("reclaim")
    ? encodeReclaim
    : encodePlain;
}
