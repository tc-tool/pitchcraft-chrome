import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

/**
 * NextAuth (Auth.js v5) config.
 *
 * Reads AUTH_SECRET, AUTH_GOOGLE_ID, AUTH_GOOGLE_SECRET from env.
 * Sessions are JWT-based — no DB needed for the auth side.
 *
 * The `handlers` are exported so the host can re-export them at
 * app/api/auth/[...nextauth]/route.ts. `auth()` is exported so
 * server code (route handlers) can read the current session.
 */

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
    async jwt({ token, profile }) {
      // Persist Google profile email + image on the JWT so we don't
      // need to re-fetch on every request.
      if (profile) {
        token.email = profile.email ?? token.email;
        token.name = profile.name ?? token.name;
        token.picture = profile.picture ?? token.picture;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.email = token.email ?? session.user.email;
        session.user.name = token.name ?? session.user.name;
        session.user.image = (token.picture as string | undefined) ?? session.user.image;
      }
      return session;
    },
  },
  pages: {
    // We don't ship a sign-in page UI in V1.5 — sign-in is triggered
    // directly from the comment panel via signIn("google").
  },
});
