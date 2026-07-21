"use client";
import { useCallback, useState } from "react";

export function useSelectMode() {
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());

  const enter = useCallback(() => setSelecting(true), []);
  const exit = useCallback(() => {
    setSelecting(false);
    setSelected(new Set());
  }, []);
  const toggle = useCallback(
    (id: string) =>
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    [],
  );
  const selectAll = useCallback(
    (ids: string[]) =>
      setSelected((prev) =>
        prev.size === ids.length ? new Set() : new Set(ids),
      ),
    [],
  );

  return { selecting, selected, enter, exit, toggle, selectAll };
}
