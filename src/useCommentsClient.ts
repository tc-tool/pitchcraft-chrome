"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDeckId } from "./CommentsProvider";
import { notifyCommentsChanged, onCommentsChanged } from "./events";
import type { Comment, CommentStatus, Thread } from "./types";

/**
 * Client-side hook for reading + mutating comments for one slide.
 *
 * Returns both the flat list (`comments`) and the grouped structure
 * (`threads`) so consumers can pick whichever fits. Threads are
 * top-level comments with their replies attached chronologically.
 *
 * Mutations are optimistic — local state updates first, reverts on
 * server rejection.
 */
export function useCommentsForSlide(slideId: string) {
  const deckId = useDeckId();
  const [comments, setComments] = useState<Comment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Avoid stale state writes if the slide changes mid-fetch.
  const fetchTokenRef = useRef(0);

  const refresh = useCallback(async () => {
    const token = ++fetchTokenRef.current;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/comments?deckId=${encodeURIComponent(deckId)}&slideId=${encodeURIComponent(slideId)}`,
        { cache: "no-store" }
      );
      if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
      const data = (await res.json()) as { comments: Comment[] };
      if (token === fetchTokenRef.current) {
        setComments(data.comments ?? []);
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "fetch failed";
      if (token === fetchTokenRef.current) setError(msg);
    } finally {
      if (token === fetchTokenRef.current) setLoading(false);
    }
  }, [deckId, slideId]);

  useEffect(() => {
    refresh();
    // Subscribe to in-process change events so any other useCommentsForSlide
    // instance on the same slide (e.g. the pin popover and the panel both
    // open at once) refreshes when the other posts / edits / deletes /
    // resolves a comment. Without this, the two views drift out of sync.
    const unsub = onCommentsChanged((changedSlideId) => {
      if (changedSlideId === slideId) refresh();
    });
    return () => unsub();
  }, [refresh, slideId]);

  const addComment = useCallback(
    async (
      body: string,
      parentId?: string | null,
      pin?: { x: number; y: number } | null
    ) => {
      const trimmed = body.trim();
      if (!trimmed) return;

      const res = await fetch(`/api/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deckId,
          slideId,
          body: trimmed,
          parentId: parentId ?? null,
          ...(pin ? { pin } : {}),
        }),
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        throw new Error(detail?.error ?? `post failed: ${res.status}`);
      }
      const { comment } = (await res.json()) as { comment: Comment };
      setComments((prev) => [...prev, comment]);
      notifyCommentsChanged(slideId);
      return comment;
    },
    [deckId, slideId]
  );

  const editComment = useCallback(
    async (commentId: string, newBody: string) => {
      const trimmed = newBody.trim();
      if (!trimmed) return;
      const prevState = comments;
      // Optimistic — patch the body locally with an editedAt stamp.
      setComments((prev) =>
        prev.map((c) =>
          c.id === commentId
            ? { ...c, body: trimmed, editedAt: new Date().toISOString() }
            : c
        )
      );

      const res = await fetch(`/api/comments`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deckId, commentId, body: trimmed }),
      });
      if (!res.ok) {
        setComments(prevState);
        const detail = await res.json().catch(() => ({}));
        throw new Error(detail?.error ?? `edit failed: ${res.status}`);
      }
      const { comment } = (await res.json()) as { comment: Comment };
      // Sync any server-derived fields (e.g. updated mentions array).
      setComments((prev) => prev.map((c) => (c.id === commentId ? comment : c)));
      notifyCommentsChanged(slideId);
    },
    [comments, deckId, slideId]
  );

  const deleteComment = useCallback(
    async (commentId: string) => {
      const prevState = comments;
      setComments((prev) => prev.filter((c) => c.id !== commentId));

      const res = await fetch(`/api/comments`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deckId, commentId }),
      });
      if (!res.ok) {
        setComments(prevState);
        const detail = await res.json().catch(() => ({}));
        throw new Error(detail?.error ?? `delete failed: ${res.status}`);
      }
      notifyCommentsChanged(slideId);
    },
    [comments, deckId, slideId]
  );

  const setStatus = useCallback(
    async (commentId: string, status: CommentStatus) => {
      const prevState = comments;
      setComments((prev) =>
        prev.map((c) =>
          c.id === commentId
            ? {
                ...c,
                status,
                resolvedAt:
                  status === "resolved" ? new Date().toISOString() : undefined,
              }
            : c
        )
      );

      const res = await fetch(`/api/comments`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deckId, commentId, status }),
      });
      if (!res.ok) {
        setComments(prevState);
        throw new Error(`patch failed: ${res.status}`);
      }
      notifyCommentsChanged(slideId);
    },
    [comments, deckId, slideId]
  );

  // Group flat comments → threads. Top-level (parentId == null) become
  // parents; everything else attaches to its parent. Orphaned replies
  // (parent is missing) get promoted to top-level so they don't disappear.
  const threads: Thread[] = useMemo(() => {
    const byId = new Map<string, Comment>();
    for (const c of comments) byId.set(c.id, c);

    const parents: Comment[] = [];
    const repliesByParent = new Map<string, Comment[]>();

    for (const c of comments) {
      if (!c.parentId || !byId.has(c.parentId)) {
        parents.push(c);
      } else {
        const arr = repliesByParent.get(c.parentId) ?? [];
        arr.push(c);
        repliesByParent.set(c.parentId, arr);
      }
    }

    parents.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const arr of repliesByParent.values()) {
      arr.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    }

    return parents.map((parent) => ({
      parent,
      replies: repliesByParent.get(parent.id) ?? [],
    }));
  }, [comments]);

  return {
    comments,
    threads,
    loading,
    error,
    refresh,
    addComment,
    editComment,
    deleteComment,
    resolveComment: useCallback((id: string) => setStatus(id, "resolved"), [
      setStatus,
    ]),
    reopenComment: useCallback((id: string) => setStatus(id, "open"), [setStatus]),
  };
}

/**
 * Open *thread* count for a slide — replies don't add to the badge.
 * Used by CommentBadge to keep the per-slide indicator honest about
 * how many open conversations exist.
 *
 * Subscribes to in-process comment-change events so the count updates
 * the moment the panel posts / resolves / reopens a comment on the
 * same slide. Without the subscription, badges would stay stuck at
 * their initial fetch.
 */
export function useCommentCountForSlide(slideId: string): number {
  const deckId = useDeckId();
  const [count, setCount] = useState(0);

  useEffect(() => {
    let cancelled = false;

    const refresh = async () => {
      try {
        const res = await fetch(
          `/api/comments?deckId=${encodeURIComponent(deckId)}&slideId=${encodeURIComponent(slideId)}`,
          { cache: "no-store" }
        );
        if (!res.ok) return;
        const data = (await res.json()) as { comments?: Comment[] };
        if (cancelled) return;
        const open = (data.comments ?? []).filter(
          (c) => c.status === "open" && !c.parentId
        ).length;
        setCount(open);
      } catch {
        /* ignore */
      }
    };

    refresh();

    const unsub = onCommentsChanged((changedSlideId) => {
      if (changedSlideId === slideId) refresh();
    });

    return () => {
      cancelled = true;
      unsub();
    };
  }, [deckId, slideId]);

  return count;
}
