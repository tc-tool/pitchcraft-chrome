/**
 * Public CLIENT-SAFE surface of @toolofna/pitchcraft-chrome.
 *
 * Host code in client components / shared modules should import from
 * here. Server-only entries (route handlers, the Redis-backed store,
 * NextAuth handlers) live in `./server` — see ../src/server.ts.
 *
 * The two-entry-point split is deliberate: if `getStore` (which uses
 * ioredis → Node's `net` module) ever leaks into the client bundle
 * via this barrel, Webpack can't resolve `net` for the browser and
 * the build dies. Keeping it out of this file enforces the boundary.
 */

// Client UI / hooks
export { CommentsProvider, useDeckId } from "./CommentsProvider";
export { CommentBadge } from "./CommentBadge";
export { CommentPanel } from "./CommentPanel";
export { SlidePinLayer } from "./SlidePinLayer";
export {
  useCommentsForSlide,
  useCommentCountForSlide,
} from "./useCommentsClient";

export { useCurrentUser } from "./useCurrentUser";
export { useDeckUsers } from "./useDeckUsers";
export { colorForAuthor, tintForAuthor, AUTHOR_PALETTE } from "./authorColor";

// Visual tokens — shared with host chrome (e.g. an ExportPdfButton
// sitting next to CommentBadge) so the persistent slide pills all
// read as the same system. Internal panel-only tokens stay private
// to the module.
export { CHROME_PILL_BASE, CHROME_PILL_HOVER } from "./surfaceTokens";

// Motion language — exported so any chrome-adjacent UI in the host
// (e.g. the deck's chrome bar, status pill, slide chrome group) can
// pull from the same rhythm constants instead of redefining ad-hoc
// durations and easings.
export { CHROME_DURATION, CHROME_EASE, CHROME_DURATION_CLASS } from "./motion";

// Hooks that talk to the API via fetch — safe in client bundle.
export { useSlideStatuses } from "./useSlideStatuses";
export { useReorder } from "./useReorder";
export { useSlideMutations } from "./useSlideMutations";

// Pure helpers — no runtime dependencies on Node APIs.
export { applyReorder } from "./applyReorder";
export {
  canEditSlideStatus,
  canReorderSlides,
  deckOwnerEmails,
} from "./permissions";

// Types
export type {
  Comment,
  CommentRole,
  CommentStatus,
  NewCommentInput,
  UserRecord,
} from "./types";
