/**
 * Public types for the comments module.
 *
 * Kept inside the module so the host app doesn't import from
 * scattered locations. The host's own deck schema can reference
 * these types if it wants, or stay independent.
 */

export type CommentRole = "creative" | "producer" | "client";
export type CommentStatus = "open" | "resolved";

/**
 * Who may see a comment. The no-leak boundary: the production (client)
 * surface only ever renders `client` comments. Derived server-side from
 * the author's verified role — never trusted from the client.
 */
export type CommentAudience = "internal" | "client";

/** Which surface a comment was created on. Context only, not a gate. */
export type CommentOrigin = "production" | "staging";

/**
 * How a comment attaches to a slide. Supersedes the legacy `pin` (a bare
 * {x,y}). A comment may carry an `anchor` OR a `pin` (or neither =
 * slide-level); the host renders whichever is present, preferring
 * `anchor`.
 *   - slide:   the whole slide
 *   - element: a tagged content part — the renderer emits
 *              `data-anchor="<part>"` (e.g. "headline", "bullet.2", "image")
 *   - region:  a normalized box — for images, the WebGL slides, freeform
 */
export type CommentAnchor =
  | { scope: "slide" }
  | { scope: "element"; part: string; quote?: string }
  | {
      scope: "region";
      rect: { x: number; y: number; w: number; h: number };
      quote?: string;
    };

/**
 * Link back to the change that addressed a comment. Populated by the
 * traceability loop (queue dispatch + PR-merge webhook), not by users.
 */
export interface CommentResolution {
  prNumber?: number;
  prUrl?: string;
  mergedAt?: string;
}

export interface Comment {
  /** Unique id, generated server-side. */
  id: string;
  /** Deck namespace — keeps comments isolated when a creative runs many decks. */
  deckId: string;
  /** Slide id, NOT slide index — survives reordering. */
  slideId: string;
  /**
   * If set, this comment is a reply to the comment with this id. Replies
   * are one level deep — replies-to-replies are not supported. The server
   * normalizes any reply-to-a-reply by re-pointing parentId at the root.
   */
  parentId?: string | null;
  /** Markdown-flavored body. Stored as plain text for V1. */
  body: string;
  /** Verified Google email. */
  authorEmail: string;
  /** Display name from Google profile. */
  authorName: string;
  /** Optional avatar from Google profile. */
  authorImage?: string;
  /** Self-declared role. Honor system; the email is the verified part. */
  role: CommentRole;
  /**
   * Open / resolved state. Only meaningful on top-level comments — replies
   * inherit their parent's state visually. The server doesn't enforce that;
   * the UI just doesn't show resolve actions on replies.
   */
  status: CommentStatus;
  /**
   * Emails of users mentioned in this comment, deduped. Derived
   * server-side from `<@email>` tokens in the body so the data is
   * authoritative regardless of how the client constructed the comment.
   * Used for future filtering ("comments mentioning me") — not for
   * rendering, since the body itself carries the inline tokens.
   */
  mentions?: string[];
  /**
   * Spatial pin position, normalized 0-1 relative to the slide's
   * content box. Only top-level comments carry pins — replies inherit
   * their parent thread's pin location. When absent, the comment is
   * slide-level (not anchored to a specific spot).
   */
  pin?: { x: number; y: number } | null;
  /**
   * Who may see this comment. Derived server-side from the author's
   * verified role: a `client` comment is `client`-visible; `creative` /
   * `producer` comments default to `internal`. The creative can later
   * surface an internal comment to the client. Legacy comments (no
   * `audience`) are treated as `internal` — old internal notes never leak
   * onto the client surface.
   */
  audience?: CommentAudience;
  /** Surface the comment was created on (production / staging). Context only. */
  origin?: CommentOrigin;
  /**
   * Richer anchor (element / region / slide). When present the host
   * renders this instead of `pin`; `pin` stays for back-compat.
   */
  anchor?: CommentAnchor;
  /**
   * Hash + version of the anchored content at creation time, supplied by
   * the host (chrome stays content-agnostic). On render the host compares
   * to the current content to badge "changed since this note" — the
   * honest signal that the deck moved (e.g. after a PUSH or Claude rewrite).
   */
  anchorContentHash?: string;
  anchorVersion?: string;
  /**
   * Link to the change that addressed this comment. Set by the
   * traceability loop, not by users.
   */
  resolution?: CommentResolution;
  /** ISO 8601 */
  createdAt: string;
  /** ISO 8601, set when the author edits the body after posting. */
  editedAt?: string;
  /** ISO 8601, only set when status flipped to resolved. */
  resolvedAt?: string;
  /** Email of the resolver. */
  resolvedBy?: string;
  /**
   * Curator triage flag — the creative has marked this comment as
   * "queued for implementation." Drives the per-comment checkbox in
   * the panel and the bulk "Send to Claude" compile. Independent from
   * `status`: a comment can be open + queued (will act on it), open +
   * not-queued (still triaging), or resolved (already handled).
   *
   * Only the creative (per canCurate) can toggle this.
   */
  queued?: boolean;
}

/**
 * A top-level comment plus its (chronological) replies. The client
 * groups flat comments into this shape; the server stores them flat.
 */
export interface Thread {
  parent: Comment;
  replies: Comment[];
}

export interface NewCommentInput {
  slideId: string;
  body: string;
}

/**
 * Per-deck user record. Created the first time a signed-in user picks
 * their role. The server stamps every comment they post with this role,
 * so it's a one-time choice rather than a per-comment toggle.
 */
export interface UserRecord {
  email: string;
  role: CommentRole;
  /** ISO 8601 — when they first picked a role. */
  firstSeenAt: string;
  /** Optional display name from Google profile. */
  name?: string;
}
