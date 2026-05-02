"use client";

import { useCallback, useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { useDeckId } from "./CommentsProvider";
import { notifyUsersChanged } from "./events";
import type { CommentRole, UserRecord } from "./types";

interface UseCurrentUserReturn {
  /** The stored user record for this deck, or null if they haven't picked a role yet. */
  user: UserRecord | null;
  /** True while we're fetching the record after sign-in. */
  loading: boolean;
  /** True only after the fetch resolves AND no record exists. */
  needsRole: boolean;
  /** Save the role for this deck. */
  setRole: (role: CommentRole) => Promise<UserRecord>;
}

/**
 * Reads the current signed-in user's role for the active deck. If no
 * record exists yet, `needsRole` becomes true — that's the signal to
 * show the role picker.
 *
 * Re-fetches when the session email changes (sign-in / sign-out).
 */
export function useCurrentUser(): UseCurrentUserReturn {
  const deckId = useDeckId();
  const { data: session, status: authStatus } = useSession();
  const [user, setUser] = useState<UserRecord | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (authStatus !== "authenticated" || !session?.user?.email) {
      setUser(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    fetch(`/api/comments/me?deckId=${encodeURIComponent(deckId)}`, {
      cache: "no-store",
    })
      .then((r) => (r.ok ? r.json() : { user: null }))
      .then((data: { user: UserRecord | null }) => {
        if (cancelled) return;
        setUser(data.user ?? null);
      })
      .catch(() => {
        if (cancelled) return;
        setUser(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [authStatus, session?.user?.email, deckId]);

  const setRole = useCallback(
    async (role: CommentRole): Promise<UserRecord> => {
      const res = await fetch(`/api/comments/me`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deckId, role }),
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        throw new Error(detail?.error ?? `failed: ${res.status}`);
      }
      const { user: updated } = (await res.json()) as { user: UserRecord };
      setUser(updated);
      // Tell every useDeckUsers subscriber on this tab that the roster
      // has changed — they'll refetch and the typeahead picks up the
      // new user immediately after first role-pick.
      notifyUsersChanged();
      return updated;
    },
    [deckId]
  );

  return {
    user,
    loading,
    needsRole: authStatus === "authenticated" && !loading && !user,
    setRole,
  };
}
