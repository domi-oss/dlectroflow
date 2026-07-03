"use server";

import { revalidatePath } from "next/cache";
import { refreshTodaySpark, type Spark } from "@/lib/spark";

export async function refreshSpark(): Promise<Spark> {
  const spark = await refreshTodaySpark();
  revalidatePath("/dashboard");
  return spark;
}
