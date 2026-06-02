"use client";

import { useCallback, useEffect, useState } from "react";
import { useDeckId } from "./CommentsProvider";

interface UseAccentReturn {
  /**
   * The current accent-overlay color for this deck, or null if no
   * overlay is set (the deck falls back to its source `meta.accent`).
   */
  accent: string | null;
  /** Save a new accent. Server enforces the creative gate. */
  setAccent: (color: string) => Promise<void>;
  /** Drop the overlay — fall back to the deck's default accent. */
  clearAccent: () => Promise<void>;
  /** True while a write (PATCH / DELETE) is in flight. */
  busy: boolean;
  /** Last write error, or null. */
  error: string | null;
}

/**
 * Read + write the deck accent-color overlay for the active deck.
 *
 * Reads are public (fetched on mount). Writes require the creative
 * gate (canCurate) server-side.
 *
 * On a write we *also* nudge the live deck immediately by setting (or
 * removing) the `--deck-accent` inline override on the deck root
 * element (`[data-deck-root]`, set by the host's renderDeckPage
 * wrapper). That way the deck retints the instant the color changes —
 * no router refresh. On clear we remove the inline override so the
 * element falls back to whatever the next server render emits (the
 * deck's source default).
 */
export function useAccent(): UseAccentReturn {
  const deckId = useDeckId();
  const [accent, setAccentState] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const refresh = async () => {
      try {
        const res = await fetch(
          `/api/comments/accent?deckId=${encodeURIComponent(deckId)}`,
          { cache: "no-store" }
        );
        if (!res.ok) return;
        const data = (await res.json()) as { accent?: string | null };
        if (cancelled) return;
        setAccentState(data.accent ?? null);
      } catch {
        /* ignore */
      }
    };

    refresh();

    return () => {
      cancelled = true;
    };
  }, [deckId]);

  const setAccent = useCallback(
    async (color: string) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(`/api/comments/accent`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ deckId, accent: color }),
        });
        if (!res.ok) {
          const detail = await res.json().catch(() => ({}));
          throw new Error(detail?.error ?? `failed: ${res.status}`);
        }
        // Optimistic local state + live retint of the rendered deck.
        setAccentState(color);
        (
          document.querySelector("[data-deck-root]") as HTMLElement | null
        )?.style.setProperty("--deck-accent", color);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        throw e;
      } finally {
        setBusy(false);
      }
    },
    [deckId]
  );

  const clearAccent = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/comments/accent`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deckId }),
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        throw new Error(detail?.error ?? `failed: ${res.status}`);
      }
      setAccentState(null);
      // Remove the inline override so the deck root falls back to the
      // deck's default accent on the next render.
      (
        document.querySelector("[data-deck-root]") as HTMLElement | null
      )?.style.removeProperty("--deck-accent");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      throw e;
    } finally {
      setBusy(false);
    }
  }, [deckId]);

  return { accent, setAccent, clearAccent, busy, error };
}
