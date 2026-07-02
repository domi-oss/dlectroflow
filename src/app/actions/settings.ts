"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { SINGLETON_ID } from "@/lib/constants";

export async function updateAgingSettings(input: {
  agingThresholdMinutes: number;
  demoOverrideSeconds: number | null;
}) {
  const agingThresholdMinutes = Math.max(
    1,
    Math.round(input.agingThresholdMinutes || 1),
  );
  const demoOverrideSeconds =
    input.demoOverrideSeconds != null && input.demoOverrideSeconds > 0
      ? Math.round(input.demoOverrideSeconds)
      : null;

  await prisma.settings.upsert({
    where: { id: SINGLETON_ID },
    create: { id: SINGLETON_ID, agingThresholdMinutes, demoOverrideSeconds },
    update: { agingThresholdMinutes, demoOverrideSeconds },
  });
  revalidatePath("/inbox");
}
