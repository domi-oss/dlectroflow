"use client";

import { useState, useTransition } from "react";
import { disconnectGoogleTasks } from "@/app/actions/google-schedule";

type GoogleStatus = {
  configured: boolean;
  connected: boolean;
  needsReconnect: boolean;
};

/** Descriptor list = the extension point: future integrations add an entry here. */
function googleDescriptor(g: GoogleStatus) {
  const pill = !g.configured
    ? { label: "Not configured", tone: "muted" as const }
    : g.needsReconnect
      ? { label: "Reconnect needed", tone: "warn" as const }
      : g.connected
        ? { label: "Connected", tone: "ok" as const }
        : { label: "Not connected", tone: "muted" as const };
  return {
    id: "google",
    name: "Google Tasks",
    description:
      "Schedule steps and tasks into Google Tasks — a Reclaim-synced list is scheduled automatically.",
    pill,
    connectHref:
      g.configured && !g.connected ? "/api/google/oauth/start" : null,
    connectLabel: g.needsReconnect ? "Reconnect Google →" : "Connect Google →",
    canDisconnect: g.connected,
  };
}

export function IntegrationsPanel({ google }: { google: GoogleStatus }) {
  const [confirming, setConfirming] = useState(false);
  const [pending, startTransition] = useTransition();
  const d = googleDescriptor(google);
  const pillClass =
    d.pill.tone === "ok"
      ? "bg-green-100 text-green-800"
      : d.pill.tone === "warn"
        ? "bg-red-100 text-red-700"
        : "bg-muted text-muted-foreground";

  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">Integrations</h2>
      <div className="rounded-lg border p-4">
        <div className="flex items-center gap-3">
          <div className="flex-1">
            <p className="font-medium">{d.name}</p>
            <p className="text-muted-foreground text-sm">{d.description}</p>
          </div>
          <span
            className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${pillClass}`}
          >
            {d.pill.label}
          </span>
        </div>
        {!google.configured && (
          <p className="text-muted-foreground mt-3 text-sm">
            Set <code>GOOGLE_CLIENT_ID</code> /{" "}
            <code>GOOGLE_CLIENT_SECRET</code> to enable (see the README).
          </p>
        )}
        <div className="mt-3 flex items-center gap-3">
          {d.connectHref && (
            <a
              href={d.connectHref}
              className="bg-primary text-primary-foreground rounded-md px-3 py-2 text-sm font-medium"
            >
              {d.connectLabel}
            </a>
          )}
          {d.canDisconnect && !confirming && (
            <button
              type="button"
              className="text-destructive rounded-md border px-3 py-2 text-sm font-medium"
              onClick={() => setConfirming(true)}
            >
              Disconnect
            </button>
          )}
          {d.canDisconnect && confirming && (
            <>
              <span className="text-sm">
                Remove access and delete stored tokens?
              </span>
              <button
                type="button"
                disabled={pending}
                className="bg-destructive text-destructive-foreground rounded-md px-3 py-2 text-sm font-medium disabled:opacity-50"
                onClick={() =>
                  startTransition(async () => {
                    await disconnectGoogleTasks();
                    setConfirming(false);
                  })
                }
              >
                Yes, disconnect
              </button>
              <button
                type="button"
                className="rounded-md border px-3 py-2 text-sm"
                onClick={() => setConfirming(false)}
              >
                Cancel
              </button>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
