"use client";

/**
 * Comment panel — light, typography-first, frosted glass.
 *
 * Floating off-white sheet with visible edges. Cards inside are pure
 * white tinted by author. The per-slide chrome (status pill, export,
 * badge) stays dark because it lives on the dark deck — this panel is
 * the editing/review tool, intentionally distinct from the deck.
 *
 * Flow:
 *   1. Not signed in → SignInPrompt
 *   2. Signed in, no role yet → RolePicker (one-time, per deck)
 *   3. Signed in, role set → threaded comments + composer
 *
 * One-level threading. Per-slide drafts persist while panel is open.
 * Server auto-stamps each new comment with the user's stored role.
 */

import { useEffect, useRef, useState } from "react";
import {
  animate,
  AnimatePresence,
  motion,
  useDragControls,
  useMotionValue,
} from "framer-motion";
import { signIn, signOut, useSession } from "next-auth/react";
import { useCommentsForSlide } from "./useCommentsClient";
import { useCurrentUser } from "./useCurrentUser";
import { useDeckUsers } from "./useDeckUsers";
import { useDeckId } from "./CommentsProvider";
import { tintForAuthor } from "./authorColor";
import { MentionableTextarea } from "./MentionableTextarea";
import { renderBody } from "./renderBody";
import {
  CARD_RING_AND_LIFT,
  INPUT_BASE,
  PANEL_SURFACE,
  PRIMARY_BUTTON,
  SMALL_PRIMARY_BUTTON,
} from "./surfaceTokens";
import { CHROME_DURATION, CHROME_EASE } from "./motion";
import { OutlineView, type OutlineSlide } from "./OutlineView";
import type { Comment, CommentRole, Thread, UserRecord } from "./types";

interface CommentPanelProps {
  slideId: string;
  onClose: () => void;
  /**
   * Human-readable title for the slide. Used as the panel's main header
   * line. If absent, the panel falls back to showing the slideId itself.
   * The host computes this (e.g. `slide.eyebrow ?? prettifySlideId(id)`)
   * — the comments module stays neutral on slide schema specifics.
   */
  slideTitle?: string;
  /** Position of the active slide (0-based). Rendered as `01 / N` in the header. */
  slideIndex?: number;
  /** Total slide count. Required if slideIndex is provided. */
  totalSlides?: number;
  /** When set, the panel scrolls to that thread once on mount/update. */
  focusThreadId?: string | null;
  /** Called once the focus has been handled so it doesn't repeat. */
  clearFocusThreadId?: () => void;
  /** Fires when the user hovers/unhovers a pinned thread card; pass null on leave. */
  onHoverThread?: (threadId: string | null) => void;
  /**
   * Opt-in outline view. When provided, the panel grows a tab toggle
   * (Comments / Outline). Producers can drag-reorder slides; clients
   * see the list read-only. Pass a click handler so a row click can
   * navigate the deck to that slide.
   */
  outline?: {
    slides: readonly OutlineSlide[];
    onGoToSlide: (index: number) => void;
  };
  /** @deprecated kept for back-compat; ignored now that role is per-user. */
  defaultRole?: CommentRole;
}

type PanelView = "comments" | "outline";

// Per-author tint alphas. Slightly hotter than they would be on solid
// white because the panel is now translucent (66%) — the underlying
// deck darkens the effective surface, so tints need to push harder
// to register as the author's color.
const CARD_TINT_ALPHA = 0.22;
const COMPOSER_TINT_ALPHA = 0.10;

// Snap-back distance in pixels. Drop the panel within this radius of
// its origin and it animates home. Drop further and it stays put.
const SNAP_RANGE = 120;

// How close to the panel edge a pointer-down must be to start a drag.
// Inside this perimeter band the panel acts as a drag handle; outside
// (the body interior) clicks are normal — no accidental drags while
// reading or scrolling. Header height is ~80px so the top band fully
// covers it as a free bonus.
const EDGE_DRAG_THRESHOLD = 36;

// ─── Per-slide draft persistence (sessionStorage) ──────────────────────
//
// Drafts live in sessionStorage keyed by `${deckId}.${slideId}` so they
// survive panel close/reopen within the tab session. Cleared when the
// tab closes. Submitting a comment clears that slide's draft; switching
// slides saves the outgoing draft and loads the incoming one.

const DRAFT_PREFIX = "pitchcraft.draft.";

function draftKey(deckId: string, slideId: string) {
  return `${DRAFT_PREFIX}${deckId}.${slideId}`;
}

function readDraft(deckId: string, slideId: string): string {
  if (typeof window === "undefined") return "";
  try {
    return window.sessionStorage.getItem(draftKey(deckId, slideId)) ?? "";
  } catch {
    return "";
  }
}

function writeDraft(deckId: string, slideId: string, value: string) {
  if (typeof window === "undefined") return;
  try {
    const key = draftKey(deckId, slideId);
    if (value) window.sessionStorage.setItem(key, value);
    else window.sessionStorage.removeItem(key);
  } catch {
    // Storage may be full / disabled in private browsing — silent fail.
  }
}

// ──────────────────────────────────────────────────────────────────────

export function CommentPanel({
  slideId,
  onClose,
  slideTitle,
  slideIndex,
  totalSlides,
  focusThreadId,
  clearFocusThreadId,
  onHoverThread,
  outline,
}: CommentPanelProps) {
  // Tabbed view: comments (default) or outline (deck-wide slide list).
  // Outline tab only shows when the host opted in by passing `outline`.
  const [view, setView] = useState<PanelView>("comments");
  const showOutlineTab = !!outline;
  const { data: session, status: authStatus } = useSession();
  const { user, loading: userLoading, needsRole, setRole } = useCurrentUser();
  const { byEmail: usersByEmail } = useDeckUsers();
  const {
    threads,
    loading,
    error,
    addComment,
    editComment,
    deleteComment,
    resolveComment,
    reopenComment,
  } = useCommentsForSlide(slideId);

  const deckId = useDeckId();
  const currentEmail = session?.user?.email?.toLowerCase() ?? null;

  // Hydrate body from sessionStorage on mount so a draft typed on a
  // previous open of the panel is still here. Survives close/reopen
  // within the tab session.
  const [body, setBody] = useState(() => readDraft(deckId, slideId));
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [showResolved, setShowResolved] = useState(false);

  const prevSlideIdRef = useRef<string>(slideId);

  // Single effect that handles two cases:
  //   1. Slide changed — save the OUTGOING slide's draft to its own
  //      key, load the INCOMING slide's draft.
  //   2. Body changed on the same slide — persist the new body.
  // Combining keeps effect ordering predictable (no chance of writing
  // a stale body to the wrong slide's key).
  useEffect(() => {
    const prev = prevSlideIdRef.current;
    if (prev !== slideId) {
      writeDraft(deckId, prev, body);
      setBody(readDraft(deckId, slideId));
      setSubmitError(null);
      prevSlideIdRef.current = slideId;
      return;
    }
    writeDraft(deckId, slideId, body);
  }, [body, slideId, deckId]);

  // Scroll a specific thread into view when the parent asks (e.g.,
  // user clicked a pin on the slide). Briefly highlights the card so
  // the user sees which one they landed on. Cool-blue ring instead of
  // the previous amber — the chrome palette is monochromatic with a
  // subtle blue tint and amber would clash as a warm alert color.
  useEffect(() => {
    if (!focusThreadId) return;
    const el = document.querySelector<HTMLElement>(
      `[data-thread-id="${CSS.escape(focusThreadId)}"]`
    );
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      // 2px cool-blue ring, no offset. The previous ring-offset-1
      // used Tailwind's default white offset color, which painted a
      // faint white seam between the card and the ring on the cool
      // panel — visually mismatched. Removing the offset keeps the
      // focus ring flush against the card's rounded edge.
      el.classList.add("ring-2", "ring-[#7DD3FC]/70");
      setTimeout(() => {
        el.classList.remove("ring-2", "ring-[#7DD3FC]/70");
      }, 1400);
    }
    clearFocusThreadId?.();
  }, [focusThreadId, clearFocusThreadId, threads]);

  // ─── Drag + snap-back ─────────────────────────────────────────────
  // Drag the panel anywhere by its header. On release, if it's within
  // SNAP_RANGE of its origin, animate back. Otherwise stay where dropped.
  // (Closing + reopening always returns it to origin via remount.)
  const dragX = useMotionValue(0);
  const dragY = useMotionValue(0);
  const dragControls = useDragControls();

  const handleDragStart = () => {
    // Lock text selection on the page while the panel is in flight.
    // Without this, dragging over deck text triggers native selection
    // because the cursor passes through selectable content.
    document.body.style.userSelect = "none";
    document.body.style.webkitUserSelect = "none";
  };

  const handleDragEnd = () => {
    document.body.style.userSelect = "";
    document.body.style.webkitUserSelect = "";

    const dist = Math.hypot(dragX.get(), dragY.get());
    if (dist < SNAP_RANGE) {
      animate(dragX, 0, { type: "spring", stiffness: 380, damping: 28 });
      animate(dragY, 0, { type: "spring", stiffness: 380, damping: 28 });
    }
  };

  const submit = async () => {
    const trimmed = body.trim();
    if (!trimmed) return;
    setSubmitting(true);
    setSubmitError(null);
    // Clear the input immediately — the user shouldn't have to wait
    // for the server roundtrip to feel like the message went out. If
    // the post fails, we restore the draft so they can retry without
    // having lost what they typed.
    setBody("");
    try {
      await addComment(trimmed);
      // sessionStorage is cleared by the body-effect when body becomes "".
    } catch (e: unknown) {
      setSubmitError(e instanceof Error ? e.message : "Failed to post.");
      // Only restore the failed draft if the user hasn't started typing
      // a new comment in the meantime — otherwise we'd stomp their new
      // text mid-keystroke.
      setBody((current) => (current === "" ? trimmed : current));
    } finally {
      setSubmitting(false);
    }
  };

  const isAuthed = !!session?.user?.email;

  return (
    <motion.div
      data-print-hide
      data-comments-layer
      initial={{ x: 24, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: 24, opacity: 0 }}
      transition={{
        // Fade in fast so there's no long "see-through" window during
        // entrance — keeps the slide animation smooth without the deck
        // text reading through a half-faded panel. Durations + ease
        // pulled from the centralized chrome motion language so the
        // panel, pills, and popovers all settle to the same rhythm.
        x: { duration: CHROME_DURATION.panel, ease: CHROME_EASE.standard },
        opacity: { duration: CHROME_DURATION.hover, ease: CHROME_EASE.standard },
      }}
      // Pin the stacking context: explicit z-index + isolation, so the
      // panel never falls behind deck content while transform/opacity
      // are in flight.
      style={{ isolation: "isolate" }}
      className="fixed right-6 top-6 bottom-20 z-50 w-[440px] max-w-[calc(100vw-3rem)]"
    >
      <motion.aside
        drag
        dragListener={false}
        dragControls={dragControls}
        dragMomentum={false}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onPointerDown={(e) => {
          const t = e.target as HTMLElement;
          // Always bail on interactive children regardless of position.
          if (
            t.closest(
              "button, input, textarea, select, a, [data-no-drag]"
            )
          )
            return;

          // Only start a drag if the pointer is within the edge band.
          // This keeps clicks inside the body (reading / hover) from
          // accidentally turning into drags.
          const rect = e.currentTarget.getBoundingClientRect();
          const x = e.clientX - rect.left;
          const y = e.clientY - rect.top;
          const nearEdge =
            x < EDGE_DRAG_THRESHOLD ||
            y < EDGE_DRAG_THRESHOLD ||
            x > rect.width - EDGE_DRAG_THRESHOLD ||
            y > rect.height - EDGE_DRAG_THRESHOLD;
          if (!nearEdge) return;

          dragControls.start(e);
        }}
        onPointerMove={(e) => {
          // Cursor signal: grab when hovering the perimeter band, default
          // when in the body interior (or over an interactive child).
          // Children with their own cursor (textarea: text, button:
          // pointer) override naturally; this only sets the aside's own.
          const t = e.target as HTMLElement;
          if (
            t.closest(
              "button, input, textarea, select, a, [data-no-drag]"
            )
          ) {
            e.currentTarget.style.cursor = "";
            return;
          }
          const rect = e.currentTarget.getBoundingClientRect();
          const x = e.clientX - rect.left;
          const y = e.clientY - rect.top;
          const nearEdge =
            x < EDGE_DRAG_THRESHOLD ||
            y < EDGE_DRAG_THRESHOLD ||
            x > rect.width - EDGE_DRAG_THRESHOLD ||
            y > rect.height - EDGE_DRAG_THRESHOLD;
          e.currentTarget.style.cursor = nearEdge ? "grab" : "";
        }}
        style={{
          x: dragX,
          y: dragY,
          // Promote to GPU compositing layer so backdrop-filter doesn't
          // re-rasterize each frame during drag (visible as flicker on
          // the deck behind). `isolation` below seals the stacking
          // context so the blur sampling stays stable.
          willChange: "transform",
        }}
        className={`flex h-full w-full flex-col overflow-hidden rounded-3xl text-[#111] [isolation:isolate] ${PANEL_SURFACE}`}
      >
      <PanelHeader
        slideId={slideId}
        slideTitle={slideTitle}
        onClose={onClose}
        slideIndex={slideIndex}
        totalSlides={totalSlides}
        view={view}
      />

      {showOutlineTab && (
        <ViewTabs view={view} onChange={setView} />
      )}

      {/* Outer body swap: outline view ↔ role picker ↔ comments+composer.
          mode="wait" so each view fully exits before the next mounts —
          they share vertical space and would fight if rendered together.
          The outline is allowed even when `needsRole` is true (it's
          read-only for users without a role). */}
      <AnimatePresence mode="wait" initial={false}>
      {view === "outline" && outline ? (
        <motion.div
          key="outline"
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{
            duration: CHROME_DURATION.thread,
            ease: CHROME_EASE.standard,
          }}
          // No `scroll-fade-y` here. The fade uses `mask-image`, which
          // CLIPS all content inside — including drop-shadows on rows
          // being dragged. When a row was dragged downward toward the
          // bottom 28px fade region, its shadow's bottom edge got cut
          // by the mask, rendering as a hard square line. Up-drags
          // looked fine because shadows extend below, not above.
          // The outline doesn't really need the fade (short list); the
          // comments view keeps it.
          className="scrollbar-soft flex-1 px-6 pb-7 pt-5"
        >
          <OutlineView
            slides={outline.slides}
            activeIndex={slideIndex ?? 0}
            onGoToSlide={(i) => {
              outline.onGoToSlide(i);
              // After navigating, drop back to the comments view so
              // the user lands on the new slide's threads.
              setView("comments");
            }}
          />
        </motion.div>
      ) : needsRole ? (
        <motion.div
          key="picker"
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{
            duration: CHROME_DURATION.thread,
            ease: CHROME_EASE.standard,
          }}
        >
          <RolePicker
            name={session?.user?.name ?? null}
            onPick={async (r) => {
              await setRole(r);
            }}
          />
        </motion.div>
      ) : (
        <motion.div
          key="content"
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{
            duration: CHROME_DURATION.thread,
            ease: CHROME_EASE.standard,
          }}
          // Inherit the panel's flex flow so the thread list still
          // grows with `flex-1` and the composer stays pinned at the
          // bottom — without this the layout collapses.
          className="flex flex-1 flex-col min-h-0"
        >
          <div className="scrollbar-soft scroll-fade-y flex-1 px-6 pb-7 pt-7">
            {loading && (
              <p className="text-[14px] text-[#555]">Loading…</p>
            )}
            {error && (
              <p className="text-[14px] text-red-700">
                Couldn&apos;t load: {error}
              </p>
            )}
            {!loading && !error && threads.length === 0 && (
              <EmptyState signedIn={!!session} />
            )}

            {(() => {
              const open = threads.filter(
                (t) => t.parent.status === "open"
              );
              const resolved = threads.filter(
                (t) => t.parent.status === "resolved"
              );
              const allCaughtUp =
                threads.length > 0 && open.length === 0;

              return (
                <ul className="flex flex-col gap-3">
                  {/* AnimatePresence + layout on the cards lets new
                      threads slide in cleanly and resolved threads
                      collapse-fade out (the surrounding cards close
                      the gap as part of the same animation). Without
                      the layout prop, neighbors would snap. */}
                  <AnimatePresence initial={false} mode="popLayout">
                    {open.map((thread) => (
                      <ThreadCard
                        key={thread.parent.id}
                        thread={thread}
                        canAct={isAuthed}
                        currentEmail={currentEmail}
                        usersByEmail={usersByEmail}
                        onReply={async (replyBody) => {
                          await addComment(replyBody, thread.parent.id);
                        }}
                        onEdit={editComment}
                        onDelete={deleteComment}
                        onResolve={() => resolveComment(thread.parent.id)}
                        onReopen={() => reopenComment(thread.parent.id)}
                        onHover={onHoverThread}
                      />
                    ))}
                  </AnimatePresence>

                  {allCaughtUp && (
                    <li className="px-1 py-1 text-[13px] text-[#555]">
                      All caught up.
                    </li>
                  )}

                  {resolved.length > 0 && (
                    <li className="px-1 pt-1">
                      <button
                        type="button"
                        onClick={() => setShowResolved((v) => !v)}
                        className="text-[12px] text-[#555] underline-offset-2 transition-colors hover:text-[#111] hover:underline"
                      >
                        {showResolved ? "Hide" : "Show"} {resolved.length} resolved
                      </button>
                    </li>
                  )}

                  <AnimatePresence initial={false} mode="popLayout">
                    {showResolved &&
                      resolved.map((thread) => (
                        <ThreadCard
                          key={thread.parent.id}
                          thread={thread}
                          canAct={isAuthed}
                          currentEmail={currentEmail}
                          usersByEmail={usersByEmail}
                          onReply={async (replyBody) => {
                            await addComment(replyBody, thread.parent.id);
                          }}
                          onEdit={editComment}
                          onDelete={deleteComment}
                          onResolve={() => resolveComment(thread.parent.id)}
                          onReopen={() => reopenComment(thread.parent.id)}
                        />
                      ))}
                  </AnimatePresence>
                </ul>
              );
            })()}
          </div>

          <div className="border-t border-black/[0.10] px-6 pb-6 pt-4">
            {/* Auth-flow crossfade: loading → sign-in → composer.
                Each state owns a motion key so the swap reads as a
                state change ("now you're signed in") rather than a
                hard re-mount. mode="wait" lets the outgoing state
                exit before the next one enters. */}
            <AnimatePresence mode="wait" initial={false}>
              {authStatus === "loading" || userLoading ? (
                <motion.p
                  key="auth-loading"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{
                    duration: CHROME_DURATION.hover,
                    ease: CHROME_EASE.standard,
                  }}
                  className="text-[12px] text-[#555]"
                >
                  Loading…
                </motion.p>
              ) : !session ? (
                <motion.div
                  key="auth-signin"
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={{
                    duration: CHROME_DURATION.thread,
                    ease: CHROME_EASE.standard,
                  }}
                >
                  <SignInPrompt />
                </motion.div>
              ) : (
                <motion.div
                  key="auth-composer"
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={{
                    duration: CHROME_DURATION.thread,
                    ease: CHROME_EASE.standard,
                  }}
                >
                  <div className="mb-3">
                    <MentionableTextarea
                      value={body}
                      onChange={setBody}
                      onSubmit={submit}
                      placeholder="Add a comment…  Type @ to mention."
                      rows={3}
                      className={`w-full resize-none rounded-2xl px-4 py-3 text-[15px] leading-relaxed text-[#111] outline-none transition placeholder:text-[#888] ${INPUT_BASE}`}
                    />
                  </div>

                  {submitError && (
                    <p className="mb-2 text-[12px] text-red-700">{submitError}</p>
                  )}

                  <div className="flex items-end justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-3 text-[12px] text-[#444]">
                        <span className="truncate">{session.user?.email}</span>
                        <button
                          type="button"
                          onClick={() => signOut()}
                          className="shrink-0 underline-offset-2 transition-colors hover:text-[#111] hover:underline"
                        >
                          Sign out
                        </button>
                      </div>
                      {user && (
                        <div className="mt-0.5 text-[10px] font-medium uppercase tracking-[0.14em] text-[#777]">
                          {user.role}
                        </div>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={submit}
                      disabled={!body.trim() || submitting}
                      className={`shrink-0 ${PRIMARY_BUTTON}`}
                    >
                      {submitting ? "Posting…" : "Post comment"}
                    </button>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </motion.div>
      )}
      </AnimatePresence>
      </motion.aside>
    </motion.div>
  );
}

// ─── Subcomponents ─────────────────────────────────────────────────────

function PanelHeader({
  slideId,
  slideTitle,
  onClose,
  slideIndex,
  totalSlides,
  view,
}: {
  slideId: string;
  slideTitle?: string;
  onClose: () => void;
  slideIndex?: number;
  totalSlides?: number;
  view: PanelView;
}) {
  const showCounter =
    typeof slideIndex === "number" &&
    typeof totalSlides === "number" &&
    totalSlides > 0;

  // Title varies by view. In comments mode the header anchors to the
  // active slide. In outline mode it's deck-wide — slide title would
  // be wrong, so we show "Slide order" instead.
  const isOutline = view === "outline";

  return (
    <header className="flex shrink-0 cursor-grab items-start justify-between gap-3 px-6 pt-6 pb-5 active:cursor-grabbing">
      <div className="min-w-0 select-none">
        <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-[#555]">
          {isOutline ? "Outline" : "Comments"}
        </p>
        <h2 className="mt-1 truncate text-[17px] font-medium tracking-tight text-[#111]">
          {isOutline ? "Slide order" : slideTitle ?? slideId}
        </h2>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        {/* Slide counter only makes sense in comments view (it points
            to the active slide). In outline view it'd be misleading. */}
        {!isOutline && showCounter && (
          <span className="relative inline-block w-[2ch] overflow-hidden text-right text-[12px] font-medium tabular-nums text-[#666]">
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.span
                key={slideIndex}
                initial={{ opacity: 0, y: -6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 6 }}
                transition={{ duration: CHROME_DURATION.micro, ease: CHROME_EASE.standard }}
                className="block"
              >
                {String(slideIndex + 1).padStart(2, "0")}
              </motion.span>
            </AnimatePresence>
          </span>
        )}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close comments"
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[#444] ring-1 ring-black/[0.20] transition-colors hover:text-[#111] hover:ring-black/40"
        >
          <CloseIcon />
        </button>
      </div>
    </header>
  );
}

/**
 * Two-segment view toggle. Sits below the header; only rendered when
 * the host opts into the outline tab. Pill style matches the chrome
 * pill cluster — two adjacent buttons with the active one filled.
 *
 * The active "pill" background is a single motion.div with a shared
 * layoutId, so toggling tabs slides the fill from one button to the
 * other instead of snapping. Same spring physics as the row reorder
 * — keeps the chrome's motion language consistent.
 */
function ViewTabs({
  view,
  onChange,
}: {
  view: PanelView;
  onChange: (next: PanelView) => void;
}) {
  const tabs: Array<{ id: PanelView; label: string }> = [
    { id: "comments", label: "Comments" },
    { id: "outline", label: "Outline" },
  ];

  return (
    <div
      role="tablist"
      data-no-drag
      className="mx-6 mb-4 flex shrink-0 items-center gap-1 rounded-full bg-black/[0.04] p-1 ring-1 ring-black/[0.06]"
    >
      {tabs.map(({ id, label }) => {
        const active = view === id;
        return (
          <button
            key={id}
            type="button"
            onClick={() => onChange(id)}
            aria-pressed={active}
            className={`relative flex-1 rounded-full px-3 py-1.5 text-[11px] font-medium uppercase tracking-[0.14em] transition-colors ${
              active ? "text-[#111]" : "text-[#666] hover:text-[#111]"
            }`}
          >
            {active && (
              <motion.span
                layoutId="view-tab-active"
                className="absolute inset-0 rounded-full bg-black/[0.08]"
                transition={{
                  type: "spring",
                  stiffness: 700,
                  damping: 38,
                  mass: 0.6,
                }}
                aria-hidden
              />
            )}
            <span className="relative">{label}</span>
          </button>
        );
      })}
    </div>
  );
}

function ThreadCard({
  thread,
  canAct,
  currentEmail,
  usersByEmail,
  onReply,
  onEdit,
  onDelete,
  onResolve,
  onReopen,
  onHover,
}: {
  thread: Thread;
  canAct: boolean;
  currentEmail: string | null;
  usersByEmail: Map<string, UserRecord>;
  onReply: (body: string) => Promise<void>;
  onEdit: (commentId: string, body: string) => Promise<void>;
  onDelete: (commentId: string) => Promise<void>;
  onResolve: () => Promise<void>;
  onReopen: () => Promise<void>;
  onHover?: (threadId: string | null) => void;
}) {
  const { parent, replies } = thread;
  const isResolved = parent.status === "resolved";

  const [replyOpen, setReplyOpen] = useState(false);
  const [replyBody, setReplyBody] = useState("");
  const [posting, setPosting] = useState(false);
  const [replyError, setReplyError] = useState<string | null>(null);

  const submitReply = async () => {
    if (!replyBody.trim()) return;
    setPosting(true);
    setReplyError(null);
    try {
      await onReply(replyBody);
      setReplyBody("");
      setReplyOpen(false);
    } catch (e: unknown) {
      setReplyError(e instanceof Error ? e.message : "Failed to reply.");
    } finally {
      setPosting(false);
    }
  };

  const isPinned = !!parent.pin;

  return (
    <motion.li
      layout
      // `layoutId` makes Framer Motion treat the same thread as a
      // single moving element across AnimatePresence boundaries —
      // when a thread resolves and the user has "Show N resolved"
      // open, the card slides from its old position in the open list
      // to its new position in the resolved list instead of
      // teleporting (vanish-then-reappear).
      layoutId={parent.id}
      // Enter: slight downward fade-in. Exit: collapse-fade-up;
      // height crunches via the layout prop on neighbors closing the
      // gap. Reads as "this thread settled in" / "this thread was
      // resolved and put away" without theatrical motion.
      initial={{ opacity: 0, y: -6, scale: 0.98 }}
      animate={{ opacity: isResolved ? 0.55 : 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -8, scale: 0.97 }}
      transition={{
        duration: CHROME_DURATION.thread,
        ease: CHROME_EASE.standard,
        opacity: { duration: CHROME_DURATION.hover },
      }}
      onMouseEnter={isPinned ? () => onHover?.(parent.id) : undefined}
      onMouseLeave={isPinned ? () => onHover?.(null) : undefined}
      className="flex flex-col gap-2"
    >
      <CommentBlock
        comment={parent}
        usersByEmail={usersByEmail}
        currentEmail={currentEmail}
        onEdit={onEdit}
        onDelete={onDelete}
        // Mark only the parent card so the pin-click focus highlight
        // wraps the rounded rectangle, not the replies + action row.
        dataThreadId={parent.id}
      />
      {replies.map((c) => (
        <CommentBlock
          key={c.id}
          comment={c}
          indented
          usersByEmail={usersByEmail}
          currentEmail={currentEmail}
          onEdit={onEdit}
          onDelete={onDelete}
        />
      ))}

      {canAct && (
        <div className="ml-1 mt-1 flex items-center gap-2 text-[12px] text-[#555]">
          <button
            type="button"
            onClick={() => {
              setReplyOpen((v) => !v);
              setReplyError(null);
            }}
            className="underline-offset-2 transition-colors hover:text-[#111] hover:underline"
          >
            {replyOpen ? "Cancel reply" : "Reply"}
          </button>
          <Dot />
          <button
            type="button"
            onClick={isResolved ? onReopen : onResolve}
            className="underline-offset-2 transition-colors hover:text-[#111] hover:underline"
          >
            {isResolved ? "Reopen" : "Mark resolved"}
          </button>
        </div>
      )}

      {replyOpen && (
        <div className="ml-6 mt-1">
          <MentionableTextarea
            value={replyBody}
            onChange={setReplyBody}
            onSubmit={submitReply}
            placeholder="Reply…  Type @ to mention."
            rows={2}
            autoFocus
            className={`w-full resize-none rounded-xl px-3.5 py-2.5 text-[14px] leading-relaxed text-[#111] outline-none transition placeholder:text-[#888] ${INPUT_BASE}`}
          />
          {replyError && (
            <p className="mt-2 text-[12px] text-red-700">{replyError}</p>
          )}
          <div className="mt-2 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setReplyOpen(false);
                setReplyBody("");
                setReplyError(null);
              }}
              className="text-[12px] text-[#444] underline-offset-2 transition-colors hover:text-[#111] hover:underline"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submitReply}
              disabled={!replyBody.trim() || posting}
              className={SMALL_PRIMARY_BUTTON}
            >
              {posting ? "Posting…" : "Post"}
            </button>
          </div>
        </div>
      )}
    </motion.li>
  );
}

function CommentBlock({
  comment: c,
  indented = false,
  usersByEmail,
  currentEmail,
  onEdit,
  onDelete,
  dataThreadId,
}: {
  comment: Comment;
  indented?: boolean;
  usersByEmail: Map<string, UserRecord>;
  currentEmail: string | null;
  onEdit: (commentId: string, body: string) => Promise<void>;
  onDelete: (commentId: string) => Promise<void>;
  /** When set, this div is the scroll target for pin-click → focus thread. */
  dataThreadId?: string;
}) {
  const isMine =
    !!currentEmail && c.authorEmail.toLowerCase() === currentEmail;

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(c.body);
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const startEdit = () => {
    setDraft(c.body);
    setEditing(true);
    setEditError(null);
  };

  const cancelEdit = () => {
    setEditing(false);
    setEditError(null);
  };

  const saveEdit = async () => {
    if (!draft.trim() || draft.trim() === c.body.trim()) {
      cancelEdit();
      return;
    }
    setSaving(true);
    setEditError(null);
    try {
      await onEdit(c.id, draft);
      setEditing(false);
    } catch (e: unknown) {
      setEditError(e instanceof Error ? e.message : "Failed to save.");
    } finally {
      setSaving(false);
    }
  };

  const doDelete = async () => {
    setDeleting(true);
    try {
      await onDelete(c.id);
      // Component will unmount on success.
    } catch {
      setDeleting(false);
      setConfirmDelete(false);
    }
  };

  return (
    <div
      data-thread-id={dataThreadId}
      className={`rounded-2xl px-4 py-3 transition-shadow ${CARD_RING_AND_LIFT} ${
        indented ? "ml-6" : ""
      }`}
      style={{ backgroundColor: tintForAuthor(c.authorEmail, CARD_TINT_ALPHA) }}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 truncate text-[15px] font-medium leading-tight text-[#111]">
          {formatDisplayName(c.authorName)}
        </div>
        <RoleTag role={c.role} />
      </div>

      {/* Read ↔ edit crossfade. `mode="popLayout"` removes the exiting
          element from layout flow so the entering element takes its
          position immediately — no brief height collapse. Parent
          <motion.li> has `layout`, smoothing any height delta. */}
      <AnimatePresence mode="popLayout" initial={false}>
        {editing ? (
          <motion.div
            key="edit"
            initial={{ opacity: 0, y: -2 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -2 }}
            transition={{
              duration: CHROME_DURATION.hover,
              ease: CHROME_EASE.standard,
            }}
            // Symmetric vertical rhythm: the textarea breathes
            // equally between the name above and the action row
            // below, so it visually anchors the card.
            className="mt-3"
          >
            <MentionableTextarea
              value={draft}
              onChange={setDraft}
              onSubmit={saveEdit}
              placeholder="Edit your comment…"
              rows={2}
              autoFocus
              className={`w-full resize-none rounded-xl px-3.5 py-2.5 text-[14px] leading-relaxed text-[#111] outline-none transition placeholder:text-[#888] ${INPUT_BASE}`}
            />
            {editError && (
              <p className="mt-2 text-[12px] text-red-700">{editError}</p>
            )}
            <div className="mt-3 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={cancelEdit}
                className="text-[12px] text-[#444] underline-offset-2 transition-colors hover:text-[#111] hover:underline"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={saveEdit}
                disabled={!draft.trim() || saving}
                className={SMALL_PRIMARY_BUTTON}
              >
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </motion.div>
        ) : (
          <motion.p
            key="read"
            initial={{ opacity: 0, y: -2 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -2 }}
            transition={{
              duration: CHROME_DURATION.hover,
              ease: CHROME_EASE.standard,
            }}
            className="mt-1 whitespace-pre-wrap text-[15px] leading-snug text-[#1A1A1A]"
          >
            {renderBody(c.body, usersByEmail)}
          </motion.p>
        )}
      </AnimatePresence>

      {/* Footer fades out when entering edit mode so the focus moves
          cleanly to the textarea + save/cancel without competing UI. */}
      <AnimatePresence initial={false}>
        {!editing && (
          <motion.div
            key="footer"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{
              duration: CHROME_DURATION.hover,
              ease: CHROME_EASE.standard,
            }}
            className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] uppercase tracking-[0.14em] text-[#666]">

          <span>
            {formatRelative(c.createdAt)}
            {c.editedAt && (
              <span className="ml-1 text-[#888]">· edited</span>
            )}
          </span>
          {isMine && (
            <>
              <span className="text-[#999]">·</span>
              {confirmDelete ? (
                <>
                  <button
                    type="button"
                    onClick={doDelete}
                    disabled={deleting}
                    className="normal-case tracking-normal text-[12px] text-red-700 underline-offset-2 hover:underline disabled:opacity-50"
                  >
                    {deleting ? "Deleting…" : "Confirm delete"}
                  </button>
                  <span className="text-[#999]">·</span>
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(false)}
                    disabled={deleting}
                    className="normal-case tracking-normal text-[12px] text-[#444] underline-offset-2 hover:text-[#111] hover:underline"
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={startEdit}
                    className="normal-case tracking-normal text-[12px] text-[#444] underline-offset-2 hover:text-[#111] hover:underline"
                  >
                    Edit
                  </button>
                  <span className="text-[#999]">·</span>
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(true)}
                    className="normal-case tracking-normal text-[12px] text-[#444] underline-offset-2 hover:text-[#111] hover:underline"
                  >
                    Delete
                  </button>
                </>
              )}
            </>
          )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function RolePicker({
  name,
  onPick,
}: {
  name: string | null;
  onPick: (r: CommentRole) => Promise<void>;
}) {
  const [pending, setPending] = useState<CommentRole | null>(null);
  const [error, setError] = useState<string | null>(null);

  const choose = async (r: CommentRole) => {
    setPending(r);
    setError(null);
    try {
      await onPick(r);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Couldn't save role.");
      setPending(null);
    }
  };

  const options: Array<{ id: CommentRole; title: string; description: string }> = [
    {
      id: "creative",
      title: "Creative",
      description: "Designing and building the deck.",
    },
    {
      id: "producer",
      title: "Producer",
      description: "Shaping story, copy, and slide order.",
    },
    {
      id: "client",
      title: "Client",
      description: "Reviewing and reacting to the work.",
    },
  ];

  return (
    <div className="flex flex-1 flex-col px-6 pb-6">
      <div className="mb-5">
        <p className="text-[14px] leading-relaxed text-[#222]">
          {name ? `Welcome, ${name.split(" ")[0]}.` : "Welcome."} Pick your role
          for this deck — you&apos;ll only see this once.
        </p>
      </div>

      <div className="flex flex-col gap-2.5">
        {options.map((opt) => {
          const busy = pending === opt.id;
          return (
            <button
              key={opt.id}
              type="button"
              onClick={() => choose(opt.id)}
              disabled={pending !== null}
              // Monochromatic role-card: recessed well in the panel
              // surface, hover deepens the well + intensifies the ring.
              // No bright off-white slab.
              className="group rounded-2xl bg-black/[0.04] px-5 py-4 text-left ring-1 ring-black/[0.08] shadow-[inset_0_1px_2px_rgba(0,0,0,0.04)] transition hover:bg-black/[0.06] hover:ring-black/[0.18] disabled:cursor-not-allowed"
            >
              <div className="flex items-baseline justify-between">
                <span className="text-[15px] font-medium text-[#111]">
                  {opt.title}
                </span>
                {busy && (
                  <span className="text-[10px] uppercase tracking-[0.14em] text-[#888]">
                    Saving…
                  </span>
                )}
              </div>
              <p className="mt-1 text-[13px] leading-relaxed text-[#555]">
                {opt.description}
              </p>
            </button>
          );
        })}
      </div>

      {error && <p className="mt-4 text-[12px] text-red-700">{error}</p>}

      <p className="mt-auto pt-6 text-[10px] uppercase tracking-[0.14em] text-[#777]">
        Verified via Google
      </p>
    </div>
  );
}

function RoleTag({ role }: { role: CommentRole }) {
  return (
    <span className="inline-flex shrink-0 items-center rounded-full bg-black/[0.08] px-2.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em] text-[#444] ring-1 ring-black/[0.06]">
      {role}
    </span>
  );
}

/**
 * Empty state for the comment list.
 *
 * Quiet hierarchy — small monochrome pin glyph, single-line header
 * ("No comments yet"), helper line that surfaces the shift-click pin
 * affordance. Most users won't discover that gesture without help.
 *
 * Faded in slightly so it doesn't pop hard when the panel opens —
 * matches the rest of the chrome's settled rhythm.
 */
function EmptyState({ signedIn }: { signedIn: boolean }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{
        duration: CHROME_DURATION.thread,
        ease: CHROME_EASE.standard,
        delay: 0.04,
      }}
      className="flex flex-col items-start gap-2.5 pt-1"
    >
      <span
        aria-hidden
        className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-black/[0.04] ring-1 ring-black/[0.06]"
      >
        <PinIcon />
      </span>
      <div className="flex flex-col gap-1">
        <p className="text-[14px] font-medium leading-tight text-[#222]">
          No comments yet
        </p>
        <p className="max-w-[34ch] text-[13px] leading-relaxed text-[#666]">
          {signedIn
            ? "Add a note below, or shift-click the slide to pin one to a spot."
            : "Sign in below to leave a comment."}
        </p>
      </div>
    </motion.div>
  );
}

function SignInPrompt() {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[14px] leading-relaxed text-[#222]">
        Sign in to leave a comment. Comments are tied to your verified
        Google email.
      </p>
      <button
        type="button"
        onClick={() => signIn("google")}
        className={`inline-flex items-center justify-center gap-2 self-start ${PRIMARY_BUTTON.replace("py-2", "py-2.5")}`}
      >
        <GoogleMark />
        Sign in with Google
      </button>
    </div>
  );
}

function Dot() {
  return <span className="text-black/30">·</span>;
}

function CloseIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      aria-hidden
    >
      <path d="M3.5 3.5l7 7M10.5 3.5l-7 7" />
    </svg>
  );
}

function PinIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className="text-[#444]"
    >
      <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z" />
      <circle cx="12" cy="9" r="2.5" />
    </svg>
  );
}

function GoogleMark() {
  return (
    <svg
      aria-hidden
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="currentColor"
      className="opacity-95"
    >
      <path d="M21.35 11.1H12v3.2h5.35c-.23 1.4-1.7 4.1-5.35 4.1-3.22 0-5.85-2.66-5.85-5.95S8.78 6.5 12 6.5c1.83 0 3.05.78 3.75 1.45l2.55-2.45C16.7 3.95 14.55 3 12 3 6.93 3 2.85 7.08 2.85 12.15 2.85 17.22 6.93 21.3 12 21.3c6.93 0 9.15-4.85 9.15-7.4 0-.5-.05-1.85-.05-2.8z" />
    </svg>
  );
}

function formatDisplayName(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return name;
  const first = parts[0];
  const lastInitial = parts[parts.length - 1].charAt(0).toUpperCase();
  return `${first} ${lastInitial}.`;
}

function formatRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return "just now";
  const sec = Math.floor(ms / 1000);
  if (sec < 30) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(iso).toLocaleDateString();
}
