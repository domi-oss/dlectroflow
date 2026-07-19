/*
  Warnings:

  - You are about to drop the column `reclaimSynced` on the `FocusSession` table. All the data in the column will be lost.
  - You are about to drop the column `reclaimTaskId` on the `Step` table. All the data in the column will be lost.
  - You are about to drop the `ReclaimAuth` table. If the table is not empty, all the data it contains will be lost.

*/
-- AlterTable
ALTER TABLE "FocusSession" DROP COLUMN "reclaimSynced";

-- AlterTable
ALTER TABLE "Step" DROP COLUMN "reclaimTaskId";

-- DropTable
DROP TABLE "ReclaimAuth";
