"use client";

import { useCallback, useState } from "react";
import { useDeckId } from "./CommentsProvider";

/**
 * Result envelope every mutation returns. The mutations now go through
 * the Claude PR dispatch instead of writing the file directly — so
 * "success" means an issue was created and Claude is on it, not that
 * the change is already live. The caller surfaces the PR / issue URL
 * so the user knows where to follow along + merge.
 */
export interface SlideMutationResult {
  ok: boolean;
  /** GitHub issue created for this dispatch. */
  issueUrl?: string;
  /** Surfaced error if `ok: false`. */
  error?: string;
}

interface UseSlideMutationsReturn {
  /**
   * Dispatch an "add a placeholder slide after this id (or at top if
   * null)" request to Claude. The slide doesn't appear immediately —
   * the user must merge the resulting PR + wait for Railway redeploy.
   */
  addSlide: (afterId: string | null) => Promise<SlideMutationResult>;
  /**
   * Dispatch a "delete this slide" request to Claude. Same async
   * semantics as addSlide — the slide remains visible until the PR
   * lands and Railway redeploys.
   */
  deleteSlide: (slideId: string) => Promise<SlideMutationResult>;
  /** True while either operation's POST is in flight. */
  busy: boolean;
  /** Last error message, or null. Cleared on the next call. */
  error: string | null;
}

/**
 * Slide source mutations — composes a prompt server-side and creates a
 * labeled GitHub issue that fires the deck repo's claude-triage workflow.
 * Claude opens a PR with the change; the creative reviews and merges.
 *
 * Why this isn't a direct file write: `deck.content.ts` is bundled into
 * the Next.js server at build time. A file write on Railway succeeds
 * but doesn't reload the in-memory bundle, so the change is invisible;
 * the next deploy resets the file from git anyway. The PR path is the
 * only reliable way to mutate deck source in production.
 *
 * Permission is enforced server-side. The UI in the outline view
 * additionally hides these affordances unless the caller has
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
          issueUrl?: string;
          error?: string;
        };
        if (!res.ok || !data.ok) {
          const message =
            data.error ?? `Failed to add slide (${res.status})`;
          setError(message);
          return { ok: false, error: message };
        }
        return { ok: true, issueUrl: data.issueUrl };
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
          issueUrl?: string;
          error?: string;
        };
        if (!res.ok || !data.ok) {
          const message =
            data.error ?? `Failed to delete slide (${res.status})`;
          setError(message);
          return { ok: false, error: message };
        }
        return { ok: true, issueUrl: data.issueUrl };
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
