"use client";

import { useState, useTransition } from "react";
import { refreshSpark } from "@/app/actions/spark";

export function SparkCard({ initial }: { initial: string }) {
  const [quote, setQuote] = useState(initial);
  const [pending, start] = useTransition();

  const refresh = () =>
    start(async () => {
      const s = await refreshSpark();
      setQuote(s.quote);
    });

  return (
    <div className="rounded-xl border bg-gradient-to-br from-amber-50 to-rose-50 p-5 dark:from-amber-950/20 dark:to-rose-950/20">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-sm font-medium">✨ Daily spark</span>
        <button
          onClick={refresh}
          disabled={pending}
          className="text-muted-foreground hover:text-foreground text-xs underline disabled:opacity-50"
        >
          {pending ? "…" : "new spark"}
        </button>
      </div>
      <p className="text-lg font-medium text-pretty">{quote}</p>
    </div>
  );
}
