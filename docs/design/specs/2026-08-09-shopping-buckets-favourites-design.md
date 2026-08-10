# Shopping list — three buckets, reusable favourites, and drag (#219)

**Status:** design, owner-approved 2026-08-09
**Issue:** #219 · follows #199 (!294, !295) · templates split to #221
**Milestone:** v0.6.0

## Goal

The shopping list should read like the shop: **the things still to get, the things already in the basket, and the staples you buy every week**. Today it is one active list where a ticked item stays in place, plus an undated "saved for later" pile that empties itself as you use it.

Three sections, in reading order: **To buy → In basket → Saved favourites**.

## Non-goals

- **Named templates** ("Weekly shop", "Roast dinner"). Split to #221 and unscheduled — it needs a parent/child table and its own management surface, and folding it in would roughly double this issue.
- **Rewards.** Shopping earns nothing, by owner decision. `shopping.test.ts` pins the absence, because "deliberately absent" and "forgotten" look identical in a diff.
- **Offline capture.** That is #175 and it is still awaiting its own brainstorm.
- **Sharing a list between people.** `ShoppingItem` is workspace-scoped like everything else; nothing here changes tenancy.
- **A separate "purchased" bucket distinct from "in basket".** The owner named one bucket two ways; it is one bucket, called In basket.

## Current state

#199 shipped `ShoppingItem` with two booleans and `splitShoppingList` deriving two sections:

| Behaviour today | Where |
|---|---|
| A ticked item **stays in the active section**, deliberately | `src/lib/shopping.ts:126-128` |
| `savedForLater` is an undated pile; pulling an item back **removes it** from the pile | `src/app/actions/shopping.ts` |
| `shoppingRemainingCount` excludes anything `done` **or** `savedForLater` | `src/lib/shopping.ts:153-157` |
| Ticking is a two-way toggle; nothing auto-clears | `setShoppingItemDone` |

Using it surfaced that the saved pile was being used as a staples list, which it cannot be: it holds the *same row*, so it empties as you shop.

One defect found in the same reading, **fixed in !295** and recorded here only so this document is a complete account: `setShoppingItemSavedForLater(id, false)` writes only `savedForLater` and never clears `done`, so an item ticked and then saved comes back **still ticked** — present in the active list but excluded from the count. Duo found it independently on !295.

## Design

### Data model

`ShoppingItem` loses `savedForLater`. Two buckets come off `done`:

- `done: false` → **To buy**
- `done: true` → **In basket**

A new table holds the third section:

```prisma
model ShoppingFavourite {
  id          String   @id @default(cuid())
  text        String
  order       Int
  createdAt   DateTime @default(now())
  workspaceId String
  // ... workspace relation, matching ShoppingItem

  @@unique([workspaceId, text])
}
```

**A favourite is a reusable name, not a row that moves.** Tapping one creates a *new* `ShoppingItem` with that text; the favourite is untouched. That asymmetry is the entire point — a staples list that empties as you shop is not a staples list.

`@@unique([workspaceId, text])` prevents two "milk". The 200-character bound and whitespace refusal mirror `ShoppingItem_text_check` (migration `20260808120000_shopping_items`), as a CHECK constraint registered in `LENGTH_REGISTRY` (`src/lib/enum-constraint-sync.integration.test.ts`) so dropping it out of band fails the suite.

### Transitions

| Gesture | Effect |
|---|---|
| Tick an item in To buy | After a short delay, animated, the row moves to In basket |
| Untick an item in In basket | Moves back to To buy |
| Star an item | Creates a favourite with the same text; the row stays where it is |
| Unstar | Removes the favourite; the item row is untouched |
| Tap a favourite | Creates a new To-buy item; the favourite stays |
| Drag between To buy and In basket | Sets `done` |
| Drag within a bucket | Rewrites `order` |

**Ticking moves the row, overriding `shopping.ts:126-128`.** That comment's reasoning is real — moving a row out from under the finger that just tapped it is what makes a checklist feel broken — and it is answered rather than ignored: the row stays put for a beat, visibly ticked, then animates down. Under `prefers-reduced-motion` the delay stays and the animation does not.

**Saved favourites is not a drop target.** Dragging into a library is ambiguous about whether the source row leaves; a star toggle is not. Drag therefore means exactly two things — change bucket, or change order — and never "copy".

### Reusing the inbox machinery

The inbox already solved keyboard-accessible drag with screen-reader announcements. Both relevant modules are pure — no React, no DOM, no server actions — with colocated tests:

- `src/components/inbox/move-dispatch.ts` — `dropPlan(source, target)`, a non-invertible source→target mapping shared by drag and the "Move to…" menu so the two can never disagree.
- `src/components/inbox/drag-announce.ts` — lift/over/moved/not-moved/cancelled announcements.

Both are typed to the inbox's five-member `BucketId`. **Generalise them over a bucket-id type parameter and move them to `src/components/dnd/`**, rather than copying them into `shopping/`. Copying is how the two would drift, and the announcements are the part that carries the WCAG obligation.

Shopping then gets its own `src/components/shopping/bucket.ts` in the house shape — a pure module with no `fs`, unit-testable on synthetic input — declaring three bucket ids and their string keys.

Within-bucket reordering is **new behaviour**: `dropPlan` currently returns `noop` for a same-bucket drop. The `order` column already exists, so the schema is unaffected; what is new is the reorder write and its concurrency story. `nextShoppingOrder` already allocates `max+1` and can duplicate under concurrent adds, with `splitShoppingList` breaking ties on `id` — a reorder must preserve that property rather than assume `order` is unique.

### Migration

One migration, in this order:

1. Create `ShoppingFavourite` with its constraint.
2. Backfill: for every `ShoppingItem` with `savedForLater: true`, insert a favourite with the same text, de-duplicating on `(workspaceId, text)`.
3. Drop `ShoppingItem.savedForLater`.

The backfilled items are **not** deleted — they become ordinary rows in To buy or In basket according to their `done`, which is the honest reading of "this was on my list".

## Risks

**The migration is the dangerous part of this issue.** It rewrites a table with live rows, which is the exact shape of the P3009 production incident on 2026-08-07: a data migration that had only ever been exercised against empty tables. It must run against seeded data before it goes near production, using the harness #190/!292 adds. **A green pipeline is not sufficient evidence here** — the seeded run is.

Secondary: dropping a column is not reversible by rolling the deployment back. The backfill must be verified complete before step 3, and step 3 is what makes this a forward-only change.

## Testing

- Pure units on the new `bucket.ts` and on the reorder allocator, on synthetic input.
- The round-trip that #199 got wrong, as a regression pin: an item that has been ticked and starred and dragged must end up somewhere the count agrees with.
- Migration exercised against a **seeded** database (#190).
- `@axe-core/playwright` on the three-section page, plus keyboard-only drag: lift, move across a bucket boundary, cancel with Escape, and confirm the live region announces each.
- The feature gate re-asserted on every new server action. A new action is a new POST endpoint, and a gate only on the page would make the Settings switch cosmetic.

## Decisions taken, recorded so they are not re-argued

1. **Tapping a favourite copies; it does not move.** The alternative — one row visiting three buckets — is much less work and was rejected because the staples list would empty itself.
2. **Ticking moves the row**, with a delay-then-animate to answer the original objection.
3. **Favourites is not a drop target**; a star toggle instead.
4. **!294 merges first**, and this lands on top with a second migration. Changing a table that shipped days ago is cheap; shipping nothing for two weeks is not.
5. **Generalise the inbox drag modules rather than copying them.**
