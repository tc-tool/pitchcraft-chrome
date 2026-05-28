"use client";

import { useCallback, useEffect, useState } from "react";
import { useDeckId } from "./CommentsProvider";
import { notifyCommentsChanged, onCommentsChanged } from "./events";
import type { Comment } from "./types";

/**
 * Client hook that owns the curator's triage queue.
 *
 * The "queue" is the set of comments the creative has flagged for
 * implementation. Comments enter the queue via the per-comment
 * QueueToggle, leave the queue when un-toggled or when the comment is
 * deleted. The QueueBar surfaces the count + a Send-to-Claude action.
 *
 * Exposes:
 *   - queue        — Comment[] currently triaged in, sorted oldest first
 *   - toggle(...)  — PATCH /api/comments with { queued: boolean }
 *   - compile()    — synthesize the markdown prompt for Claude
 *   - reload()     — manual refetch (useful right before compile)
 *   - loading      — true while the initial fetch is in flight
 *   - error        — last fetch/mutation error if any
 *
 * Refreshes itself whenever a comment is created/deleted (via the
 * existing `onCommentsChanged` event bus) so a comment that gets
 * deleted while queued falls out of the bar without a manual reload.
 *
 * Returns an empty queue if the viewer isn't authorized to curate —
 * the server returns 403 in that case, which we treat as "no queue
 * to show" rather than an error.
 */
export function useQueue() {
  const deckId = useDeckId();
  const [queue, setQueue] = useState<Comment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/comments/queue?deckId=${encodeURIComponent(deckId)}`
      );
      if (res.status === 403 || res.status === 401) {
        // Not the curator — quietly leave the queue empty so the UI
        // never even renders the bar for producers/clients.
        setQueue([]);
        return;
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(body.error ?? `queue fetch failed (${res.status})`);
      }
      const data = (await res.json()) as { queued: Comment[] };
      setQueue(data.queued ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [deckId]);

  // Initial load + listen for comment-list changes so the queue
  // reflects deletions in real time.
  useEffect(() => {
    void reload();
    return onCommentsChanged(() => {
      void reload();
    });
  }, [reload]);

  const toggle = useCallback(
    async (commentId: string, queued: boolean) => {
      setError(null);
      // Optimistic — flip in local state immediately so the checkbox
      // feels instant. We reconcile on the server response.
      setQueue((prev) => {
        if (!queued) return prev.filter((c) => c.id !== commentId);
        // Adding back: we don't have the full Comment yet from this
        // call site (the toggle component only knows the id). Best
        // path is to let the server respond, then reload.
        return prev;
      });

      try {
        const res = await fetch("/api/comments", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ deckId, commentId, queued }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          throw new Error(body.error ?? `toggle failed (${res.status})`);
        }
        // Server returns the updated comment — use its slideId to fire
        // a comments-changed event so the per-comment QueueToggle in
        // the panel reads the fresh `queued` flag. Without this the
        // checkbox visually stays empty until the panel reloads, which
        // looks like "nothing happened."
        const data = (await res.json().catch(() => ({}))) as {
          comment?: Comment;
        };
        if (data.comment?.slideId) {
          notifyCommentsChanged(data.comment.slideId);
        }
        // Reload to pull the canonical queue (covers the "add" case
        // where we didn't have the Comment locally).
        await reload();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        // Reload to recover from the optimistic state.
        await reload();
        throw e;
      }
    },
    [deckId, reload]
  );

  /**
   * Compile the queue into a markdown prompt for Claude.
   *
   * Format optimized for a fresh Claude Code session:
   *   - Names the deck dir explicitly so cd is unambiguous
   *   - Groups feedback by slide id (which maps to deck.content.ts entries)
   *   - Surfaces author + role so contradictions can be weighted
   *   - Tells Claude NOT to mark resolved (Tyler does that manually as
   *     he reviews each change)
   */
  const compile = useCallback((deckTitle?: string): string => {
    if (queue.length === 0) return "";

    const grouped = new Map<string, Comment[]>();
    for (const c of queue) {
      const bucket = grouped.get(c.slideId) ?? [];
      bucket.push(c);
      grouped.set(c.slideId, bucket);
    }

    const headerName = deckTitle ?? deckId;
    const lines: string[] = [
      `The following pitch feedback has been triaged for implementation`,
      `in the deck *${headerName}* (working directory \`~/Desktop/Tyler/toolOS/${deckId}/\`).`,
      ``,
      `Make the changes to \`content/deck.content.ts\` (and any slide`,
      `files referenced). When you're done, commit on a NEW branch`,
      `(name it something like \`claude/triage-<short-summary>\`) and`,
      `open a pull request titled with a one-line summary of what`,
      `changed. Do NOT push directly to main — Tyler reviews each`,
      `change via the PR diff before merging.`,
      ``,
      `Don't mark comments as resolved — Tyler will do that manually`,
      `as he reviews each change.`,
      ``,
      `---`,
      ``,
    ];

    for (const [slideId, items] of grouped) {
      lines.push(`## Slide: \`${slideId}\``);
      lines.push(``);
      for (const c of items) {
        const when = relativeTime(c.createdAt);
        // Strip internal `<@email>` tokens — they're noise in the prompt.
        const body = c.body.replace(/<@([^>\s]+)>/g, "@$1").trim();
        lines.push(`> **${c.authorName}** (${c.role}, ${when})`);
        for (const para of body.split(/\n+/)) {
          lines.push(`> ${para}`);
        }
        lines.push(``);
      }
    }

    lines.push(`---`);
    lines.push(``);
    lines.push(
      `Implement each thoughtfully. If feedback contradicts itself`
    );
    lines.push(
      `or doesn't match what's actually in the file, flag it rather`
    );
    lines.push(`than guessing. Don't touch slides not listed here.`);

    return lines.join("\n");
  }, [queue, deckId]);

  return { queue, loading, error, toggle, reload, compile };
}

// ─── Helpers ──────────────────────────────────────────────────────────

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const seconds = Math.max(1, Math.round((now - then) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}
