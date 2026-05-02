"use client";

import { useEffect, useMemo, useState } from "react";
import { useDeckId } from "./CommentsProvider";
import { onUsersChanged } from "./events";
import type { UserRecord } from "./types";

interface UseDeckUsersReturn {
  /** Every user who's signed in + picked a role for this deck. */
  users: UserRecord[];
  /** Email-keyed lookup, used by the mention chip renderer. */
  byEmail: Map<string, UserRecord>;
  loading: boolean;
}

/**
 * Roster of users on the active deck. Drives the @mention typeahead
 * AND the chip renderer (which looks up display name + color by email).
 *
 * Refetches immediately after `useCurrentUser.setRole` succeeds via
 * the in-process pubsub (events.ts) — so the very first sign-in flow
 * doesn't leave the user invisible to subsequent typeaheads.
 */
export function useDeckUsers(): UseDeckUsersReturn {
  const deckId = useDeckId();
  const [users, setUsers] = useState<UserRecord[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    const refresh = async () => {
      try {
        const res = await fetch(
          `/api/comments/users?deckId=${encodeURIComponent(deckId)}`,
          { cache: "no-store" }
        );
        if (!res.ok) return;
        const data = (await res.json()) as { users?: UserRecord[] };
        if (cancelled) return;
        setUsers(data.users ?? []);
      } catch {
        /* ignore */
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    refresh();
    const unsub = onUsersChanged(() => refresh());

    return () => {
      cancelled = true;
      unsub();
    };
  }, [deckId]);

  const byEmail = useMemo(() => {
    const map = new Map<string, UserRecord>();
    for (const u of users) map.set(u.email.toLowerCase(), u);
    return map;
  }, [users]);

  return { users, byEmail, loading };
}
