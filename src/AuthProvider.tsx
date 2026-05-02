"use client";

import { SessionProvider } from "next-auth/react";
import type { ReactNode } from "react";

/**
 * Thin wrapper around NextAuth's SessionProvider. Lets the host wrap
 * the deck once at the root and not import next-auth/react directly.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  return <SessionProvider>{children}</SessionProvider>;
}
