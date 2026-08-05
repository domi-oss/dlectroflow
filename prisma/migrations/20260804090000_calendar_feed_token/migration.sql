-- #154 — the per-user calendar subscription feed's capability token.
--
-- Named `calendar_feed_token` rather than `calendar_feed` so it cannot collide
-- with any other migration landing in the same release; nothing here touches an
-- existing table's columns, only `User`'s incoming foreign key.
--
-- `token` is UNIQUE because it is the lookup key on the public feed endpoint:
-- the index is what makes an unknown token a single indexed miss rather than a
-- scan, and the constraint is what makes "two accounts share a credential"
-- unrepresentable.
CREATE TABLE "CalendarFeed" (
    "userId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rotatedAt" TIMESTAMP(3),

    CONSTRAINT "CalendarFeed_pkey" PRIMARY KEY ("userId")
);

CREATE UNIQUE INDEX "CalendarFeed_token_key" ON "CalendarFeed"("token");

-- Cascade: deleting an account destroys its feed in the same statement. A
-- REVOKED account keeps its row and is refused at resolve time instead — see the
-- schema comment.
ALTER TABLE "CalendarFeed"
    ADD CONSTRAINT "CalendarFeed_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
