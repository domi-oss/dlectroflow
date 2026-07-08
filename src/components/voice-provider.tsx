"use client";

import { createContext, useContext } from "react";
import type { Voice } from "@/lib/strings";

const VoiceContext = createContext<Voice>("plain");

/**
 * VoiceProvider — client component that carries the workspace voice down the
 * React tree. The server layout reads the voice from the DB and passes it as a
 * prop; this context then makes it available to any client component via
 * `useVoice()` without re-fetching.
 *
 * The `t()` helper in strings.ts stays pure (no context access) so it can be
 * called directly in server components too.
 */
export function VoiceProvider({
  voice,
  children,
}: {
  voice: Voice;
  children: React.ReactNode;
}) {
  return (
    <VoiceContext.Provider value={voice}>{children}</VoiceContext.Provider>
  );
}

/** Returns the current workspace voice. Defaults to "plain" if no provider. */
export function useVoice(): Voice {
  return useContext(VoiceContext);
}
