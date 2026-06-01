"use client";

import { useCallback, useState } from "react";
import { useDeckId } from "./CommentsProvider";

/**
 * Result envelope every mutation returns. Add/delete are instant
 * overlay writes — "success" means the change is already live in
 * staging. The caller follows up with `router.refresh()` so the deck +
 * outline re-render with the change applied. No PR, no merge, no wait.
 */
export interface SlideMutationResult {
  ok: boolean;
  /** Add only — the generated id of the new placeholder slide. */
  slideId?: string;
  /** Surfaced error if `ok: false`. */
  error?: string;
}

interface UseSlideMutationsReturn {
  /**
   * Add a placeholder slide after this id (or at the top if null). The
   * slide is recorded in the added-slides overlay immediately; call
   * `router.refresh()` on success and it appears in the deck + outline.
   */
  addSlide: (afterId: string | null) => Promise<SlideMutationResult>;
  /**
   * Delete a slide. Recorded in the deleted overlay immediately; call
   * `router.refresh()` on success and it vanishes from the deck +
   * outline. It stays gone (overlay persists in Redis), and PUSH bakes
   * the deletion into production.
   */
  deleteSlide: (slideId: string) => Promise<SlideMutationResult>;
  /** True while either operation's request is in flight. */
  busy: boolean;
  /** Last error message, or null. Cleared on the next call. */
  error: string | null;
}

/**
 * Slide structural mutations — add and delete, as instant overlay writes.
 *
 * These hit `/api/slides`, which records the change in Redis and returns
 * right away. The slide doesn't round-trip through git: deletions and
 * additions live in overlays that the deck render applies in staging and
 * that PUSH bakes into production. The host's `deck.content.ts` is only
 * reconciled later, deliberately, through Claude Code.
 *
 * Permission is enforced server-side (creative role + owner allowlist).
 * The outline view also hides these affordances unless the caller has
 * `canCurate`, so producers/clients never see the buttons.
 */
export function useSlideMutations(): UseSlideMutationsReturn {
  const deckId = useDeckId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const addSlide = useCallback(
    async (afterId: string | null): Promise<SlideMutationResult> => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch("/api/slides", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ deckId, afterId }),
        });
        const data = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          slideId?: string;
          error?: string;
        };
        if (!res.ok || !data.ok) {
          const message = data.error ?? `Failed to add slide (${res.status})`;
          setError(message);
          return { ok: false, error: message };
        }
        return { ok: true, slideId: data.slideId };
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : "Failed to add slide.";
        setError(message);
        return { ok: false, error: message };
      } finally {
        setBusy(false);
      }
    },
    [deckId]
  );

  const deleteSlide = useCallback(
    async (slideId: string): Promise<SlideMutationResult> => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch("/api/slides", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ deckId, slideId }),
        });
        const data = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          error?: string;
        };
        if (!res.ok || !data.ok) {
          const message =
            data.error ?? `Failed to delete slide (${res.status})`;
          setError(message);
          return { ok: false, error: message };
        }
        return { ok: true };
      } catch (e: unknown) {
        const message =
          e instanceof Error ? e.message : "Failed to delete slide.";
        setError(message);
        return { ok: false, error: message };
      } finally {
        setBusy(false);
      }
    },
    [deckId]
  );

  return { addSlide, deleteSlide, busy, error };
}
