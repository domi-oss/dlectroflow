import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/db";

const A = "test-ws-A";
const B = "test-ws-B";

describe("workspace isolation", () => {
  beforeAll(async () => {
    await prisma.workspace.createMany({
      data: [
        { id: A, kind: "guest" },
        { id: B, kind: "guest" },
      ],
      skipDuplicates: true,
    });
    await prisma.brainDumpItem.create({
      data: { text: "secret-A", workspaceId: A },
    });
  });

  afterAll(async () => {
    await prisma.brainDumpItem.deleteMany({
      where: { workspaceId: { in: [A, B] } },
    });
    await prisma.workspace.deleteMany({ where: { id: { in: [A, B] } } });
    await prisma.$disconnect();
  });

  it("workspace B cannot see workspace A's item", async () => {
    const seen = await prisma.brainDumpItem.findMany({
      where: { workspaceId: B },
    });
    expect(seen).toHaveLength(0);
  });

  it("workspace A sees only its own item", async () => {
    const seen = await prisma.brainDumpItem.findMany({
      where: { workspaceId: A },
    });
    expect(seen.map((i) => i.text)).toEqual(["secret-A"]);
  });
});
