"use client";

import { createContext, useContext, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { AuthProvider } from "./AuthProvider";

/**
 * Per-deck context. Whatever `deckId` you pass becomes the namespace
 * for every comment posted on this site — comments are isolated per
 * deck even if multiple decks share the same KV store.
 *
 * Wrap the deck root once:
 *
 *   <CommentsProvider deckId="acmeco-pitch">
 *     ...your deck...
 *   </CommentsProvider>
 *
 * Pulls the SessionProvider in too, so the host doesn't need to wrap
 * separately.
 *
 * ── Surface ──────────────────────────────────────────────────────────
 * The provider also knows which SURFACE it's on — the client-facing
 * production link, or the team's staging link. This drives two things:
 *   - comments get an `origin` stamp (production / staging), and
 *   - on production, a signed-in viewer with no role is treated as a
 *     client (the role picker is a staging/team concept).
 *
 * It's auto-detected from the path so a host doesn't have to thread mode
 * through its server layout: anything under `stagingPathPrefix`
 * (default `/staging`, the Pitchcraft platform convention) is staging;
 * everything else is production. A host that doesn't follow the
 * convention can pass `surface` explicitly to override.
 */

export type CommentSurface = "production" | "staging";

interface CommentsContextValue {
  deckId: string;
  surface: CommentSurface;
}

const CommentsContext = createContext<CommentsContextValue | null>(null);

export function CommentsProvider({
  deckId,
  surface,
  stagingPathPrefix = "/staging",
  children,
}: {
  deckId: string;
  /** Override the auto-detected surface (rarely needed). */
  surface?: CommentSurface;
  /** Path prefix that marks the staging surface. Default `/staging`. */
  stagingPathPrefix?: string;
  children: ReactNode;
}) {
  const pathname = usePathname();
  // Explicit prop wins; else detect from the path. Unknown (null) path
  // resolves to "staging" — the conservative default (no auto-client, no
  // chance of mislabeling a team member as a client).
  const resolvedSurface: CommentSurface =
    surface ??
    (pathname && !pathname.startsWith(stagingPathPrefix)
      ? "production"
      : "staging");

  return (
    <AuthProvider>
      <CommentsContext.Provider
        value={{ deckId, surface: resolvedSurface }}
      >
        {children}
      </CommentsContext.Provider>
    </AuthProvider>
  );
}

export function useDeckId(): string {
  const ctx = useContext(CommentsContext);
  if (!ctx) {
    throw new Error(
      "useDeckId must be used inside <CommentsProvider deckId=… />"
    );
  }
  return ctx.deckId;
}

/**
 * The current review surface. Defaults to "staging" outside a provider
 * (the safe, team-only assumption) so callers never need to null-check.
 */
export function useCommentSurface(): CommentSurface {
  return useContext(CommentsContext)?.surface ?? "staging";
}
