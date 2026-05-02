/**
 * Server-only exports of @toolofna/pitchcraft-chrome.
 *
 * Anything in here either uses Node-only APIs (ioredis, net sockets)
 * or wraps server-side logic (NextAuth handlers, route handlers that
 * touch the store). Importing from this entry point in a client
 * component will fail at build time — that's intentional.
 *
 * Host wiring:
 *   app/api/comments/route.ts:
 *     export {
 *       commentsGET as GET, commentsPOST as POST,
 *       commentsPATCH as PATCH, commentsDELETE as DELETE,
 *     } from "@toolofna/pitchcraft-chrome/server";
 *
 *   app/api/auth/[...nextauth]/route.ts:
 *     export { authHandlers as GET, authHandlers as POST } from
 *       "@toolofna/pitchcraft-chrome/server";
 *
 *   app/page.tsx (server component):
 *     import { getStore } from "@toolofna/pitchcraft-chrome/server";
 */

// NextAuth — server-side handlers and auth() helper.
export { handlers as authHandlers, auth, signIn, signOut } from "./authConfig";

// Route handlers the deck exports through `app/api/comments/*`.
export {
  GET as commentsGET,
  POST as commentsPOST,
  PATCH as commentsPATCH,
  DELETE as commentsDELETE,
  meGET,
  mePOST,
  usersGET,
  slideStatusGET,
  slideStatusPATCH,
  reorderGET,
  reorderPATCH,
  reorderDELETE,
} from "./routeHandlers";

// The store — uses ioredis. Importing this on the client side leads
// to "Module not found: Can't resolve 'net'" because ioredis depends
// on Node's TCP sockets. Server-only.
export { getStore } from "./store";
