"use client";

import { useEffect, useMemo, useState } from "react";
import { useSession } from "next-auth/react";
import { AnimatePresence, motion, Reorder, useDragControls } from "framer-motion";
import { useCurrentUser } from "./useCurrentUser";
import { useReorder } from "./useReorder";
import { useSlideMutations } from "./useSlideMutations";
import { canEditSlideStatus, canReorderSlides } from "./permissions";
import { CHROME_DURATION, CHROME_EASE } from "./motion";
import { applyReorder } from "./applyReorder";

/**
 * The minimal slide shape OutlineView needs. Hosts pass their own
 * `DeckSlide[]` mapped to this — keeps the chrome neutral on schema.
 */
export interface OutlineSlide {
  id: string;
  title: string;
}

interface OutlineViewProps {
  /** All slides in source order. Required. */
  slides: readonly OutlineSlide[];
  /** Index of the currently active slide (highlighted in the list). */
  activeIndex: number;
  /** Click on a row → host navigates to that slide. */
  onGoToSlide: (index: number) => void;
}

/**
 * Deck-wide outline view. Producers (and creatives) can reorder slides
 * via drag-and-drop; clients see a read-only list. The reorder writes
 * to a KV overlay (not source) — see `useReorder` and `applyReorder`.
 *
 * Renders as the body of the comment panel when its `view` is "outline".
 */
export function OutlineView({
  slides,
  activeIndex,
  onGoToSlide,
}: OutlineViewProps) {
  const { data: session } = useSession();
  const { user } = useCurrentUser();
  const { order: overlayOrder, setOrder, clearOrder } = useReorder();
  const slideMutations = useSlideMutations();

  const canReorder = canReorderSlides(session?.user?.email, user?.role);
  // Add/delete is a stronger gate than reorder — writes to source. Same
  // permission as slide-status (creative + email allowlist).
  const canMutate = canEditSlideStatus(session?.user?.email, user?.role);

  // Local list state — drives the Reorder.Group. Initialized from the
  // effective order (overlay applied to source) so the list matches
  // what the deck is rendering.
  const effective = useMemo(
    () => applyReorder(slides, overlayOrder),
    [slides, overlayOrder]
  );
  const [list, setList] = useState<readonly OutlineSlide[]>(effective);

  // Track whether the user is currently dragging so we can suppress
  // click-to-navigate during a drag (Framer fires both events).
  const [dragging, setDragging] = useState(false);

  // Number of in-flight `setOrder` commits. The list-sync effect must
  // NOT overwrite `list` while a commit is racing the fetch — without
  // this gate, the post-drop window between drag-end and fetch-resolve
  // is a guaranteed reset of the user's intent back to stale
  // `effective`. The visual symptom: drag a slide, drop it, watch it
  // animate back to its source position, then snap to the dropped
  // position once the server lands. Reads as "drop didn't take."
  // Using a counter (not a boolean) so rapid drags don't desync — the
  // counter only hits 0 when the LAST in-flight fetch settles.
  const [pendingCommits, setPendingCommits] = useState(0);

  // Sync local list from upstream `effective` ONLY when the user
  // isn't mid-drag AND no commit is in flight, AND only when the
  // contents have actually diverged. Otherwise we'd thrash the
  // Reorder.Group's `values` for no reason every time `effective`'s
  // useMemo returns a new array reference.
  useEffect(() => {
    if (dragging || pendingCommits > 0) return;
    setList((prev) => {
      if (
        prev.length === effective.length &&
        prev.every((s, i) => s.id === effective[i]?.id)
      ) {
        return prev;
      }
      return effective;
    });
  }, [effective, dragging, pendingCommits]);

  const hasOverlay = overlayOrder !== null;

  // The "Reorder applied" banner is gated by a *stable* state that only
  // updates when the user isn't actively dragging. Without this, the
  // first drag flips hasOverlay from false → true mid-drag, which
  // would pop the banner into the layout above the list, shift the
  // rows down, and visually break the drag. Sync only when settled.
  const [showBanner, setShowBanner] = useState(hasOverlay);
  useEffect(() => {
    if (!dragging) setShowBanner(hasOverlay);
  }, [dragging, hasOverlay]);

  const commitOrder = (next: readonly OutlineSlide[]) => {
    const ids = next.map((s) => s.id);
    // Don't write if nothing actually changed.
    const sameAsEffective =
      ids.length === effective.length &&
      ids.every((id, i) => effective[i]?.id === id);
    if (sameAsEffective) return;

    // Increment in-flight counter so the list-sync effect knows not
    // to revert local list to stale effective while we're waiting on
    // the server. Decrement when this specific commit settles, win
    // or lose. The counter (vs. boolean) handles overlapping commits
    // correctly when the user is drag-stepping rapidly.
    setPendingCommits((n) => n + 1);

    // Optimistic — Reorder already updated `list`; sync to server.
    setOrder(ids)
      .catch((err) => {
        console.warn("[reorder] save failed; reverting", err);
        setList(effective);
      })
      .finally(() => {
        setPendingCommits((n) => Math.max(0, n - 1));
      });
  };

  const reset = async () => {
    try {
      await clearOrder();
    } catch (err) {
      console.warn("[reorder] clear failed", err);
    }
  };

  if (slides.length === 0) {
    return (
      <p className="px-1 text-[14px] text-[#555]">No slides to show.</p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Banner: appears only when an overlay is currently applied.
          Gated by `showBanner` (not `hasOverlay`) so its visibility
          doesn't flip mid-drag — see the useEffect above. Reset is
          a one-click clear back to source order.

          Wrapped in AnimatePresence with a height-collapse exit so
          the rest of the list slides up cleanly when the overlay is
          cleared, instead of snapping. `overflow-hidden` is on the
          motion wrapper so the height animation clips correctly. */}
      <AnimatePresence initial={false}>
        {showBanner && (
          <motion.div
            key="reorder-banner"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{
              duration: CHROME_DURATION.thread,
              ease: CHROME_EASE.standard,
            }}
            className="overflow-hidden"
          >
            <div className="flex items-center justify-between gap-3 rounded-xl bg-black/[0.04] px-3 py-2 ring-1 ring-black/[0.06]">
              <div className="flex flex-col">
                <span className="text-[11px] font-medium uppercase tracking-[0.14em] text-[#555]">
                  Reorder applied
                </span>
                <span className="text-[12px] text-[#666]">
                  Showing producer-defined order.
                </span>
              </div>
              {canReorder && (
                <button
                  type="button"
                  onClick={reset}
                  className="shrink-0 text-[12px] text-[#444] underline-offset-2 transition-colors hover:text-[#111] hover:underline"
                >
                  Reset
                </button>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Mutation error banner — surfaces add/delete failures without
          interrupting the rest of the UI. Cleared on the next call. */}
      {canMutate && slideMutations.error && (
        <p className="text-[12px] text-red-700">{slideMutations.error}</p>
      )}

      {/* The list itself. Reorder.Group handles drag-to-reorder.
          When the user can't reorder, we still render rows but
          without drag handles or pointer events on the items. */}
      {canReorder ? (
        <Reorder.Group
          axis="y"
          values={list as OutlineSlide[]}
          onReorder={(next: OutlineSlide[]) => {
            setList(next);
            commitOrder(next);
          }}
          // `[&>li]:rounded-xl` on the parent forces border-radius on
          // every direct <li> child (the Reorder.Items). Belt-and-
          // suspenders alongside Reorder.Item's own className/style —
          // some Framer/HMR combos drop className on motion children,
          // and a parent selector survives that.
          className="flex flex-col gap-1.5 [&>li]:rounded-xl"
        >
          {/* `displayIndex` is the row's position in the current list,
              not its position in the (changing) `slides` prop. This
              decouples the row's render from upstream `slides` ref
              changes — children don't re-render mid-drag when the deck
              applies the overlay client-side, which is what was
              disrupting Framer's drag layout calc. */}
          {list.map((slide, displayIndex) => (
            <DraggableOutlineRow
              key={slide.id}
              slide={slide}
              displayIndex={displayIndex}
              isActive={displayIndex === activeIndex}
              canDelete={canMutate}
              onClick={() => {
                if (dragging) return;
                onGoToSlide(displayIndex);
              }}
              onDragStart={() => setDragging(true)}
              onDragEnd={() => {
                setTimeout(() => setDragging(false), 50);
              }}
              onDelete={async () => {
                await slideMutations.deleteSlide(slide.id);
              }}
              deleting={slideMutations.busy}
            />
          ))}
        </Reorder.Group>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {list.map((slide, displayIndex) => (
            <li key={slide.id}>
              <StaticOutlineRow
                slide={slide}
                displayIndex={displayIndex}
                isActive={displayIndex === activeIndex}
                onClick={() => {
                  onGoToSlide(displayIndex);
                }}
              />
            </li>
          ))}
        </ul>
      )}

      {/* "Add slide" affordance — creative only. Inserts a placeholder
          at the end of source. Drag-to-position is the secondary step.
          Sits below the list at the same indentation as the rows.

          Tactile press (active:scale-[0.98]) so the button feels like
          a button — same compression pattern as the panel's primary
          buttons. transition-[transform,...] keeps the press snappy
          while colors fade at the slower hover duration. */}
      {canMutate && (
        <button
          type="button"
          onClick={async () => {
            const lastId = list.length > 0 ? list[list.length - 1].id : null;
            await slideMutations.addSlide(lastId);
            // The deck's hot-reload picks up the new slide and the
            // outline re-renders; no need to manually refresh state.
          }}
          disabled={slideMutations.busy}
          className="mt-1 flex items-center gap-2 self-start rounded-xl px-3 py-2 text-[12px] font-medium text-[#666] transition-[background-color,color,transform] duration-150 ease-out hover:bg-black/[0.03] hover:text-[#111] active:scale-[0.98] active:duration-100 disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100"
        >
          <span aria-hidden className="text-[14px] leading-none">+</span>
          <span>{slideMutations.busy ? "Adding…" : "Add slide"}</span>
        </button>
      )}
    </div>
  );
}

// ─── Draggable row ─────────────────────────────────────────────────────
//
// The whole row is a `<button>` (click → navigate). Inside the button,
// the drag-handle icon owns its own pointerdown handler that calls
// dragControls.start() — which is why Reorder.Item has dragListener=false.
// This is the canonical Framer Motion pattern for "drag handle vs.
// click on the rest of the row." Without it, the button would swallow
// pointerdown events before Reorder.Item could start a drag.

function DraggableOutlineRow({
  slide,
  displayIndex,
  isActive,
  canDelete,
  onClick,
  onDragStart,
  onDragEnd,
  onDelete,
  deleting,
}: {
  slide: OutlineSlide;
  displayIndex: number;
  isActive: boolean;
  canDelete: boolean;
  onClick: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDelete: () => Promise<void>;
  deleting: boolean;
}) {
  const controls = useDragControls();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [isThisRowDragging, setIsThisRowDragging] = useState(false);

  return (
    <Reorder.Item
      value={slide}
      dragListener={false}
      dragControls={controls}
      onDragStart={() => {
        setIsThisRowDragging(true);
        onDragStart();
      }}
      onDragEnd={() => {
        setIsThisRowDragging(false);
        onDragEnd();
      }}
      transition={{
        type: "spring",
        stiffness: 700,
        damping: 38,
        mass: 0.6,
      }}
      whileDrag={{ zIndex: 50 }}
      // Border-radius via inline `style` — Framer Motion's drag system
      // writes inline `style` (transform, z-index, etc.) on this <li>,
      // so applying border-radius the same way (style, not className)
      // guarantees it lands on the element regardless of how the drag
      // styles compose. Any paint Framer does on the <li> — including
      // the residual settle-out of past whileDrag values — now follows
      // these rounded corners. No more square edges.
      style={{ borderRadius: 12 }}
      className="rounded-xl"
    >
      <div
        className={`group flex items-center rounded-xl ${
          isThisRowDragging
            ? "shadow-[0_8px_22px_rgba(0,0,0,0.14),0_1px_2px_rgba(0,0,0,0.06)] bg-[#F5F9FE]"
            : isActive
              ? "bg-black/[0.05] text-[#111]"
              : "text-[#333] hover:bg-black/[0.03] hover:text-[#111]"
        }`}
      >
        <button
          type="button"
          onClick={onClick}
          className="flex flex-1 items-center gap-3 rounded-xl px-3 py-2 text-left"
        >
          <span
            aria-hidden
            onPointerDown={(e) => {
              e.preventDefault();
              controls.start(e);
            }}
            // The drag-handle's own affordance: dim by default, dots
            // darken on row hover so the user reads "this row can be
            // moved", a subtle bg pop on direct hover/active so the
            // handle reads as a real grab target the moment the
            // cursor lands on it.
            className="shrink-0 cursor-grab touch-none rounded-md px-1 py-1 text-[#999] transition-colors duration-150 ease-out hover:bg-black/[0.05] hover:text-[#333] group-hover:text-[#666] active:cursor-grabbing"
          >
            <DragHandleIcon />
          </span>
          <span className="w-[2.5ch] shrink-0 text-[11px] font-medium tabular-nums text-[#888]">
            {String(displayIndex + 1).padStart(2, "0")}
          </span>
          <span className="min-w-0 flex-1 truncate text-[14px] font-medium">
            {slide.title}
          </span>
        </button>

        {canDelete && (
          <RowDeleteAffordance
            confirming={confirmDelete}
            onArm={() => setConfirmDelete(true)}
            onCancel={() => setConfirmDelete(false)}
            onConfirm={async () => {
              await onDelete();
              setConfirmDelete(false);
            }}
            busy={deleting}
          />
        )}
      </div>
    </Reorder.Item>
  );
}

// ─── Per-row delete affordance ─────────────────────────────────────────
//
// Two states:
//   1. Idle — fades in only on row hover (group-hover) so unarmed rows
//      stay visually quiet.
//   2. Armed — explicit "Delete?" confirm + cancel inline. The arm
//      lives until the user confirms, cancels, or moves their mouse
//      away long enough for them to lose track (we don't auto-dismiss;
//      arming is a deliberate gesture).

function RowDeleteAffordance({
  confirming,
  onArm,
  onCancel,
  onConfirm,
  busy,
}: {
  confirming: boolean;
  onArm: () => void;
  onCancel: () => void;
  onConfirm: () => void;
  busy: boolean;
}) {
  // Crossfade between idle (trash icon) and armed (Delete | Cancel).
  // mode="wait" lets the outgoing state finish exiting before the
  // incoming arrives — they share horizontal space and would jostle
  // if rendered together. Slight x-offset on enter/exit makes the
  // direction of state change feel intentional.
  return (
    <AnimatePresence mode="wait" initial={false}>
      {confirming ? (
        <motion.div
          key="confirm"
          initial={{ opacity: 0, x: 4 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: 4 }}
          transition={{ duration: 0.14, ease: [0.22, 1, 0.36, 1] }}
          className="flex shrink-0 items-center gap-1 pr-2 text-[11px] uppercase tracking-[0.14em]"
        >
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="rounded-md px-2 py-1 text-red-700 transition-colors hover:bg-red-700/[0.08] disabled:opacity-50"
          >
            {busy ? "…" : "Delete"}
          </button>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-md px-2 py-1 text-[#666] transition-colors hover:text-[#111] disabled:opacity-50"
          >
            Cancel
          </button>
        </motion.div>
      ) : (
        <motion.button
          key="trash"
          initial={{ opacity: 0, x: -4 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -4 }}
          transition={{ duration: 0.14, ease: [0.22, 1, 0.36, 1] }}
          type="button"
          onClick={onArm}
          aria-label="Delete slide"
          className="mr-1 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[#888] opacity-0 transition-colors duration-150 hover:bg-black/[0.04] hover:text-[#444] group-hover:opacity-100 focus-visible:opacity-100"
        >
          <TrashIcon />
        </motion.button>
      )}
    </AnimatePresence>
  );
}

function TrashIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M2.5 4h11" />
      <path d="M5.5 4V2.5h5V4" />
      <path d="M4 4l.7 9.2a1 1 0 0 0 1 .8h4.6a1 1 0 0 0 1-.8L12 4" />
      <path d="M6.5 7v4M9.5 7v4" />
    </svg>
  );
}

// ─── Static (read-only) row ────────────────────────────────────────────

function StaticOutlineRow({
  slide,
  displayIndex,
  isActive,
  onClick,
}: {
  slide: OutlineSlide;
  displayIndex: number;
  isActive: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors ${
        isActive
          ? "bg-black/[0.05] text-[#111]"
          : "text-[#333] hover:bg-black/[0.03] hover:text-[#111]"
      }`}
    >
      <span className="w-[2.5ch] shrink-0 text-[11px] font-medium tabular-nums text-[#888]">
        {String(displayIndex + 1).padStart(2, "0")}
      </span>
      <span className="min-w-0 flex-1 truncate text-[14px] font-medium">
        {slide.title}
      </span>
    </button>
  );
}

function DragHandleIcon() {
  return (
    <svg
      width="10"
      height="14"
      viewBox="0 0 10 14"
      fill="currentColor"
      aria-hidden
    >
      {/* Six-dot drag affordance — a visual convention everyone reads
          as "I can grab this and move it." */}
      <circle cx="2" cy="2" r="1" />
      <circle cx="8" cy="2" r="1" />
      <circle cx="2" cy="7" r="1" />
      <circle cx="8" cy="7" r="1" />
      <circle cx="2" cy="12" r="1" />
      <circle cx="8" cy="12" r="1" />
    </svg>
  );
}
