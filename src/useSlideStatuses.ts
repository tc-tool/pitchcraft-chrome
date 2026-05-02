"use client";

import { useCallback, useEffect, useState } from "react";
import { useDeckId } from "./CommentsProvider";
import {
  notifySlideStatusesChanged,
  onSlideStatusesChanged,
} from "./events";

export type SlideStatusValue = "draft" | "review" | "approved";

interface UseSlideStatusesReturn {
  /** slideId → overlay status (only contains slides whose status was changed). */
  statuses: Record<string, SlideStatusValue>;
  loading: boolean;
  /** Save a status for a slide. Server enforces creative role. */
  setStatus: (slideId: string, status: SlideStatusValue) => Promise<void>;
}

/**
 * Read + write the per-slide status overlay for the active deck.
 *
 * Reads are public (anyone can know which slides are approved). Writes
 * are creative-only — server returns 403 if the caller isn't a creative
 * on this deck. The hook surfaces that as a thrown Error from setStatus.
 */
export function useSlideStatuses(): UseSlideStatusesReturn {
  const deckId = useDeckId();
  const [statuses, setStatuses] = useState<Record<string, SlideStatusValue>>(
    {}
  );
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    const refresh = async () => {
      try {
        const res = await fetch(
          `/api/comments/slide-status?deckId=${encodeURIComponent(deckId)}`,
          { cache: "no-store" }
        );
        if (!res.ok) return;
        const data = (await res.json()) as {
          statuses?: Record<string, SlideStatusValue>;
        };
        if (cancelled) return;
        setStatuses(data.statuses ?? {});
      } catch {
        /* ignore */
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    refresh();
    const unsub = onSlideStatusesChanged(() => refresh());

    return () => {
      cancelled = true;
      unsub();
    };
  }, [deckId]);

  const setStatus = useCallback(
    async (slideId: string, status: SlideStatusValue) => {
      const res = await fetch(`/api/comments/slide-status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deckId, slideId, status }),
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        throw new Error(detail?.error ?? `failed: ${res.status}`);
      }
      // Optimistic local update + broadcast so other badges refresh.
      setStatuses((prev) => ({ ...prev, [slideId]: status }));
      notifySlideStatusesChanged();
    },
    [deckId]
  );

  return { statuses, loading, setStatus };
}
