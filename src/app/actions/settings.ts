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

/** Feature 3/9 — end-of-day round-up delivery settings. */
export async function updateRoundupSettings(input: {
  workdayEndTime: string; // HH:mm
  roundupDemoOverride: boolean;
  roundupEmailEnabled: boolean;
  roundupEmail: string | null;
}) {
  const workdayEndTime = /^\d{2}:\d{2}$/.test(input.workdayEndTime)
    ? input.workdayEndTime
    : "17:00";
  const roundupEmail = input.roundupEmail?.trim() || null;
  const data = {
    workdayEndTime,
    roundupDemoOverride: Boolean(input.roundupDemoOverride),
    roundupEmailEnabled: Boolean(input.roundupEmailEnabled),
    roundupEmail,
  };
  await prisma.settings.upsert({
    where: { id: SINGLETON_ID },
    create: { id: SINGLETON_ID, ...data },
    update: data,
  });
  revalidatePath("/dashboard");
}
