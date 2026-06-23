import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import { isDeckOwner, TEAM_DOMAIN } from "./permissions";

/**
 * NextAuth (Auth.js v5) config.
 *
 * Reads AUTH_SECRET, AUTH_GOOGLE_ID, AUTH_GOOGLE_SECRET from env.
 * Sessions are JWT-based — no DB needed for the auth side.
 *
 * The `handlers` are exported so the host can re-export them at
 * app/api/auth/[...nextauth]/route.ts. `auth()` is exported so
 * server code (route handlers) can read the current session.
 *
 * Verified team identity
 * ----------------------
 * Clients are EXTERNAL (non-toolofna.com) and legitimately sign in to
 * view + comment as role `client`. So sign-in is NOT restricted to the
 * team domain — anyone with a Google account may authenticate. What we
 * DO compute, server-side and never trusted from the client, is whether
 * the Google identity is a verified team member: a real toolofna.com
 * account (Google's `hd` hosted-domain claim + `email_verified`), or an
 * email in the deck owner allowlist. That `isVerifiedTeam` flag is the
 * gate for all team privileges (creative/producer role, curation,
 * reorder, dispatch, publish) — a self-declared role is never enough.
 */

/**
 * Decide whether a Google profile is a verified team identity. Reads
 * Google's `hd` (hosted-domain) and `email_verified` claims — both come
 * straight from the OAuth ID token, so they're server-trusted. The owner
 * allowlist is also honored so the owner is always team even on a
 * non-domain Google account.
 */
function profileIsVerifiedTeam(profile: unknown): boolean {
  if (!profile || typeof profile !== "object") return false;
  const p = profile as {
    hd?: unknown;
    email?: unknown;
    email_verified?: unknown;
  };
  const email = typeof p.email === "string" ? p.email.toLowerCase() : null;

  // Owner allowlist is team regardless of domain.
  if (isDeckOwner(email)) return true;

  // Otherwise require BOTH a verified email AND the team hosted-domain
  // claim. `hd` is only present for Google Workspace accounts and cannot
  // be spoofed by a consumer gmail account.
  const verified = p.email_verified === true;
  const hd = typeof p.hd === "string" ? p.hd.toLowerCase() : null;
  const emailOnTeamDomain = !!email && email.endsWith(`@${TEAM_DOMAIN}`);
  return verified && hd === TEAM_DOMAIN && emailOnTeamDomain;
}

export const { handlers, signIn, signOut, auth } = NextAuth({
  providers: [
    Google({
      clientId: process.env.AUTH_GOOGLE_ID,
      clientSecret: process.env.AUTH_GOOGLE_SECRET,
    }),
  ],
  session: {
    strategy: "jwt",
  },
  callbacks: {
    // Allow every Google sign-in. Clients are external by design; we do
    // NOT block non-toolofna accounts here. The team-vs-client
    // distinction is recorded as a verified flag in `jwt` below, not by
    // refusing the sign-in.
    async signIn() {
      return true;
    },
    async jwt({ token, profile }) {
      // Persist Google profile email + image on the JWT so we don't
      // need to re-fetch on every request.
      if (profile) {
        token.email = profile.email ?? token.email;
        token.name = profile.name ?? token.name;
        token.picture = profile.picture ?? token.picture;
        // Stamp the server-trusted verified-team signal at sign-in time,
        // derived from the Google ID-token claims (hd + email_verified)
        // or the owner allowlist. Only set on the initial sign-in (when
        // `profile` is present); it rides the JWT thereafter.
        token.isVerifiedTeam = profileIsVerifiedTeam(profile);
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.email = token.email ?? session.user.email;
        session.user.name = token.name ?? session.user.name;
        session.user.image = (token.picture as string | undefined) ?? session.user.image;
        // Surface the verified-team signal so client components can gate
        // their UI (e.g. the reorder affordance) the same way the server
        // gates the action. This is a read-only signal — the server
        // re-derives authority from the session, never from the client.
        (session.user as { isVerifiedTeam?: boolean }).isVerifiedTeam =
          token.isVerifiedTeam === true;
      }
      return session;
    },
  },
  pages: {
    // We don't ship a sign-in page UI in V1.5 — sign-in is triggered
    // directly from the comment panel via signIn("google").
  },
});

/**
 * Read the server-trusted verified-team flag off a NextAuth session.
 * Centralized so route handlers don't reach into the augmented session
 * shape directly. Returns false for any session that wasn't stamped as
 * team at sign-in.
 */
export function sessionIsVerifiedTeam(session: unknown): boolean {
  if (!session || typeof session !== "object") return false;
  const user = (session as { user?: { isVerifiedTeam?: unknown } }).user;
  return user?.isVerifiedTeam === true;
}
