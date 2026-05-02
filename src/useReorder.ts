"use client";

import { useCallback, useEffect, useState } from "react";
import { useDeckId } from "./CommentsProvider";
import { notifyReorderChanged, onReorderChanged } from "./events";

interface UseReorderReturn {
  /**
   * Producer-defined slide order (array of slide ids), or null if no
   * overlay is set. The host applies this via `applyReorder()`.
   */
  order: string[] | null;
  loading: boolean;
  /** Save a new order. Server enforces creative or producer role. */
  setOrder: (slideIds: string[]) => Promise<void>;
  /** Drop the overlay — fall back to source order. */
  clearOrder: () => Promise<void>;
}

/**
 * Read + write the slide-reorder overlay for the active deck.
 *
 * Reads are public. Writes require creative or producer role.
 * Listens to in-process pubsub so a reorder triggered from one
 * surface (e.g. an outline view) refreshes other consumers.
 */
export function useReorder(): UseReorderReturn {
  const deckId = useDeckId();
  const [order, setOrderState] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    const refresh = async () => {
      try {
        const res = await fetch(
          `/api/comments/reorder?deckId=${encodeURIComponent(deckId)}`,
          { cache: "no-store" }
        );
        if (!res.ok) return;
        const data = (await res.json()) as { order?: string[] | null };
        if (cancelled) return;
        setOrderState(data.order ?? null);
      } catch {
        /* ignore */
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    refresh();
    const unsub = onReorderChanged(() => refresh());

    return () => {
      cancelled = true;
      unsub();
    };
  }, [deckId]);

  const setOrder = useCallback(
    async (slideIds: string[]) => {
      const res = await fetch(`/api/comments/reorder`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deckId, order: slideIds }),
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        throw new Error(detail?.error ?? `failed: ${res.status}`);
      }
      // Optimistic local update + broadcast.
      setOrderState(slideIds);
      notifyReorderChanged();
    },
    [deckId]
  );

  const clearOrder = useCallback(async () => {
    const res = await fetch(
      `/api/comments/reorder?deckId=${encodeURIComponent(deckId)}`,
      { method: "DELETE" }
    );
    if (!res.ok) {
      const detail = await res.json().catch(() => ({}));
      throw new Error(detail?.error ?? `failed: ${res.status}`);
    }
    setOrderState(null);
    notifyReorderChanged();
  }, [deckId]);

  return { order, loading, setOrder, clearOrder };
}
