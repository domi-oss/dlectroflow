"use server";

import { revalidatePath } from "next/cache";
import { refreshTodaySpark, type Spark } from "@/lib/spark";
import { currentWorkspaceId } from "@/lib/workspace";

export async function refreshSpark(): Promise<Spark> {
  const workspaceId = await currentWorkspaceId();
  const spark = await refreshTodaySpark(workspaceId);
  revalidatePath("/dashboard");
  return spark;
}
