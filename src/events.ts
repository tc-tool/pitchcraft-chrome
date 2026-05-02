/**
 * Tiny in-process pubsub so the per-slide CommentBadge can react when
 * the panel posts / resolves / reopens a comment on the same slide.
 *
 * Without this, the badge fetches its count once on mount and never
 * updates — so posting a new comment leaves the badge stuck at the
 * stale count.
 *
 * Scope is per-tab. Cross-tab / cross-user updates would need polling
 * or a websocket; deferred to V2.
 */

type CommentsListener = (slideId: string) => void;
const commentsListeners = new Set<CommentsListener>();

export function notifyCommentsChanged(slideId: string) {
  commentsListeners.forEach((fn) => {
    try {
      fn(slideId);
    } catch {
      /* one bad listener shouldn't break the others */
    }
  });
}

export function onCommentsChanged(fn: CommentsListener): () => void {
  commentsListeners.add(fn);
  return () => {
    commentsListeners.delete(fn);
  };
}

// ─── Users (@mention roster) ──────────────────────────────────────────
//
// Fired when someone picks/changes their role on this deck — that's the
// only path that adds a new user to the @mention list. useDeckUsers
// subscribes so the typeahead refreshes immediately after first sign-in.

type UsersListener = () => void;
const usersListeners = new Set<UsersListener>();

export function notifyUsersChanged() {
  usersListeners.forEach((fn) => {
    try {
      fn();
    } catch {
      /* swallow */
    }
  });
}

export function onUsersChanged(fn: UsersListener): () => void {
  usersListeners.add(fn);
  return () => {
    usersListeners.delete(fn);
  };
}

// ─── Slide statuses ──────────────────────────────────────────────────
//
// Fired when the creative flips a slide's status overlay. Lets the
// SlideStatusPill on every slide refresh without polling.

type StatusesListener = () => void;
const statusesListeners = new Set<StatusesListener>();

export function notifySlideStatusesChanged() {
  statusesListeners.forEach((fn) => {
    try {
      fn();
    } catch {
      /* swallow */
    }
  });
}

export function onSlideStatusesChanged(fn: StatusesListener): () => void {
  statusesListeners.add(fn);
  return () => {
    statusesListeners.delete(fn);
  };
}

// ─── Slide reorder ────────────────────────────────────────────────────
//
// Fired when a producer (or creative) drags slides into a new order in
// the outline view. Lets any open panel/badge across the same tab pick
// up the new sequence without polling.

type ReorderListener = () => void;
const reorderListeners = new Set<ReorderListener>();

export function notifyReorderChanged() {
  reorderListeners.forEach((fn) => {
    try {
      fn();
    } catch {
      /* swallow */
    }
  });
}

export function onReorderChanged(fn: ReorderListener): () => void {
  reorderListeners.add(fn);
  return () => {
    reorderListeners.delete(fn);
  };
}
