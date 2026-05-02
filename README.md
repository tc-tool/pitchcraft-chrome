# comments — drop-in module

A self-contained slide-level comment system for any cinematic deck.
Google sign-in, server-persisted comments, per-deck namespacing.

Drop the folder in. Wire two API routes. Wrap the deck root in
`<CommentsProvider deckId="...">`. Done.

## What's in the box

- `CommentsProvider` — context that gives every component a `deckId`.
- `CommentBadge` — per-slide indicator. Click → opens panel.
- `CommentPanel` — floating sheet, light/typography-first, includes
  inline Google sign-in when the visitor isn't signed in.
- `useCommentsForSlide(slideId)` — read + mutate hook.
- `useCommentCountForSlide(slideId)` — count-only hook (used by the badge).
- `authHandlers`, `commentsGET/POST/PATCH` — server route handlers.

Everything talks to `/api/auth/*` and `/api/comments` on the host
app. Zero localStorage, zero seed JSON files.

## Storage

Two implementations, picked at runtime in [store.ts](./store.ts):

- **Vercel KV (Upstash Redis)** when `KV_REST_API_URL` + `KV_REST_API_TOKEN`
  are set. This is what production uses.
- **In-memory Map** when those env vars are missing. Used in local dev
  before you've signed up Vercel — comments work end-to-end but reset
  every `next dev` reload.

Keys are namespaced by deckId so multiple decks can share one KV.

## Drop into a new deck

### 1. Copy the folder

```sh
cp -R /path/to/pitchcraft/modules/comments your-new-deck/modules/comments
```

### 2. Install dependencies

```sh
npm install next-auth@beta @upstash/redis
```

### 3. Wire the route handlers

Create `app/api/auth/[...nextauth]/route.ts`:

```ts
import { authHandlers } from "@/modules/comments";
export const { GET, POST } = authHandlers;
```

Create `app/api/comments/route.ts`:

```ts
export {
  commentsGET as GET,
  commentsPOST as POST,
  commentsPATCH as PATCH,
} from "@/modules/comments";
```

### 4. Wrap the deck root

In `app/layout.tsx`:

```tsx
import { CommentsProvider } from "@/modules/comments";

export default function RootLayout({ children }) {
  return (
    <html><body>
      <CommentsProvider deckId="your-deck-id">{children}</CommentsProvider>
    </body></html>
  );
}
```

`deckId` is the namespace key. Use kebab-case, keep it stable.

### 5. Add the badge / panel where you want them

```tsx
import { CommentBadge, CommentPanel } from "@/modules/comments";

<CommentBadge slideId="cover" onClick={() => setOpenSlide("cover")} />

{openSlide && (
  <CommentPanel slideId={openSlide} onClose={() => setOpenSlide(null)} />
)}
```

`slideId` is whatever stable string identifies the slide in your deck.

### 6. Set env vars

Copy `.env.example` to `.env.local`, fill in:

```
AUTH_SECRET=<random base64>
AUTH_GOOGLE_ID=<from google cloud console>
AUTH_GOOGLE_SECRET=<from google cloud console>
AUTH_URL=http://localhost:3000
```

Generate a secret:
```sh
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

### 7. Update Google OAuth client

In Google Cloud Console → Clients → your existing Web client (one
client serves all decks) → add to Authorized redirect URIs:

```
http://localhost:3000/api/auth/callback/google
https://your-new-deck.vercel.app/api/auth/callback/google
```

(The localhost one is shared across decks — it's already there. The
production one you add per-deck.)

### 8. Deploy

Push to GitHub, import to Vercel, enable Vercel KV in the project
storage tab, run `vercel env pull .env.local` to mirror prod KV
locally, redeploy.

## Surface area

```ts
// Client
<CommentsProvider deckId="..."> ... </CommentsProvider>
<CommentBadge slideId="..." onClick={...} />
<CommentPanel slideId="..." onClose={...} defaultRole="..." />

const { comments, addComment, resolveComment } = useCommentsForSlide(slideId);
const count = useCommentCountForSlide(slideId);

// Server (re-exports for app/api/...)
authHandlers       // → app/api/auth/[...nextauth]/route.ts
commentsGET        // → app/api/comments/route.ts (GET)
commentsPOST       // → app/api/comments/route.ts (POST)
commentsPATCH      // → app/api/comments/route.ts (PATCH)

// Types
type Comment, CommentRole, CommentStatus
```

## Storage layout

In Redis:

```
comments:{deckId}                     SET of comment ids
comments:{deckId}:by-slide:{slideId}  SET of comment ids
comments:{deckId}:item:{commentId}    JSON blob for one comment
```

To wipe a deck's comments completely, delete keys matching
`comments:{deckId}*` via `vercel kv` CLI or the Upstash console.

## What's NOT built

- Threaded replies — comments are flat per slide.
- Spatial / text-block anchoring — slide-level only.
- Email notifications.
- Edit-after-post.
- Moderation UI — you delete via KV CLI.
- Pagination — assumes ~10s of comments per slide.

If you outgrow these, swap `MemoryCommentsStore` / `KVCommentsStore`
in `store.ts` for a richer backend. Everything else (UI, hooks, route
handlers) stays put.
