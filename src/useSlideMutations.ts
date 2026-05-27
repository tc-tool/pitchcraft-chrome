"use client";

import { useCallback, useState } from "react";

interface UseSlideMutationsReturn {
  /**
   * Insert a new placeholder slide after the given id (null = top).
   * Returns the newly-generated slide id, or null if the request failed.
   * Errors surface via `error`; the caller decides how to display.
   */
  addSlide: (afterId: string | null) => Promise<string | null>;
  /**
   * Delete a slide by id. Returns true on success, false on failure.
   */
  deleteSlide: (slideId: string) => Promise<boolean>;
  /** True while either operation is in flight. */
  busy: boolean;
  /** Last error message, or null. Cleared on the next call. */
  error: string | null;
}

/**
 * Slide source mutations — talks to the host deck's `/api/slides`
 * route handler, which the deck implements (the chrome stays neutral
 * on the deck's slide schema).
 *
 * Permission is enforced server-side. The UI in the outline view
 * additionally hides these affordances unless the caller has
 * `canCurate`, so producers/clients never see the buttons.
 */
export function useSlideMutations(): UseSlideMutationsReturn {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const addSlide = useCallback(async (afterId: string | null) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/slides", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ afterId }),
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        throw new Error(detail?.error ?? `failed: ${res.status}`);
      }
      const data = (await res.json()) as { id: string };
      return data.id;
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to add slide.");
      return null;
    } finally {
      setBusy(false);
    }
  }, []);

  const deleteSlide = useCallback(async (slideId: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/slides?id=${encodeURIComponent(slideId)}`,
        { method: "DELETE" }
      );
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        throw new Error(detail?.error ?? `failed: ${res.status}`);
      }
      return true;
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to delete slide.");
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  return { addSlide, deleteSlide, busy, error };
}
