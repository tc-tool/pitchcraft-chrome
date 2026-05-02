"use client";

import { createContext, useContext, type ReactNode } from "react";
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
 */

interface CommentsContextValue {
  deckId: string;
}

const CommentsContext = createContext<CommentsContextValue | null>(null);

export function CommentsProvider({
  deckId,
  children,
}: {
  deckId: string;
  children: ReactNode;
}) {
  return (
    <AuthProvider>
      <CommentsContext.Provider value={{ deckId }}>
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
