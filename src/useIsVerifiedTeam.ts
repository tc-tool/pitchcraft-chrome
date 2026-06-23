"use client";

import { useSession } from "next-auth/react";

/**
 * Read the server-trusted "verified team identity" flag off the NextAuth
 * session for UI gating. The server stamps `session.user.isVerifiedTeam`
 * at sign-in from the Google ID-token claims (hosted-domain `hd` +
 * `email_verified`) or the owner allowlist — see authConfig.ts.
 *
 * Why a flag and not a role: a non-team Google account can authenticate
 * and pick (or be downgraded to) `client`, but it must never see team
 * affordances. The client gates (`canCurate` / `canReorderSlides`) take
 * this flag so the UI matches what the server will actually permit — a
 * verified toolofna.com creative still sees the controls even when no
 * owner allowlist is configured, while an outside account never does.
 *
 * This is purely a UI hint. The server re-derives authority from the
 * session on every mutating request; it never trusts the client.
 */
export function useIsVerifiedTeam(): boolean {
  const { data: session } = useSession();
  const user = session?.user as { isVerifiedTeam?: boolean } | undefined;
  return user?.isVerifiedTeam === true;
}
