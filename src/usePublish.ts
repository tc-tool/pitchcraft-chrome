"use client";

import { useCallback, useEffect, useState } from "react";
import { useDeckId } from "./CommentsProvider";

/**
 * Last-published snapshot envelope, mirroring `PublishedContent` in
 * the server-only store. Kept here as a duplicate (rather than
 * importing) so this file stays client-safe and doesn't pull in any
 * ioredis-adjacent code.
 */
export interface PublishedContentSummary {
  /** ISO 8601 timestamp of when the snapshot was taken. */
  publishedAt: string;
  /** Email of the creative who hit the Publish button. */
  publishedBy: string;
}

/**
 * Public hook for the publish gate.
 *
 * The host wires this in via a `<PublishButton content={deckContent} />`
 * or its own UI. The hook itself is unopinionated about presentation —
 * it just exposes the current "last published" state plus a `publish`
 * callback that uploads a snapshot.
 *
 * Why the host passes `content` to `publish()` rather than the chrome
 * importing `deckContent`: the chrome is deck-agnostic by design and
 * never reaches into the host's content schema. The host hands the
 * blob in; the chrome stores it opaquely.
 *
 * State shape:
 *   - lastPublished: the latest snapshot's metadata, or null if nothing
 *     has ever been published for this deck. Refreshes on mount and
 *     after every successful publish.
 *   - isPublishing: true while a POST is in flight.
 *   - error: surfaced from a failed POST so callers can render a toast.
 *   - publish(content): kicks off the snapshot upload. Returns the new
 *     metadata on success or throws on auth/permission failure.
 *
 * The hook does NOT diff content for you — callers receive a fresh
 * `lastPublished` after `publish()` resolves, and can compare timestamps
 * if they need to render staleness indicators.
 */
export function usePublish() {
  const deckId = useDeckId();
  const [lastPublished, setLastPublished] =
    useState<PublishedContentSummary | null>(null);
  const [isPublishing, setIsPublishing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch the current snapshot's metadata on mount. We only need
  // publishedAt + publishedBy for UI — the actual content blob isn't
  // useful client-side (the server renders production from it).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/comments/publish?deckId=${encodeURIComponent(deckId)}`
        );
        if (!res.ok) return;
        const data = (await res.json()) as {
          published: {
            publishedAt: string;
            publishedBy: string;
          } | null;
        };
        if (cancelled) return;
        setLastPublished(
          data.published
            ? {
                publishedAt: data.published.publishedAt,
                publishedBy: data.published.publishedBy,
              }
            : null
        );
      } catch {
        // Silent — a missing snapshot is fine, just leaves us at null.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [deckId]);

  const publish = useCallback(
    async (content: unknown): Promise<PublishedContentSummary> => {
      setIsPublishing(true);
      setError(null);
      try {
        const res = await fetch("/api/comments/publish", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ deckId, content }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          throw new Error(body.error ?? `publish failed (${res.status})`);
        }
        const data = (await res.json()) as {
          published: PublishedContentSummary;
        };
        setLastPublished(data.published);
        return data.published;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        setError(message);
        throw e;
      } finally {
        setIsPublishing(false);
      }
    },
    [deckId]
  );

  return { lastPublished, isPublishing, error, publish };
}
