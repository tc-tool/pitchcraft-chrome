"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useSession } from "next-auth/react";
import { useCommentsForSlide } from "./useCommentsClient";
import { tintForAuthor } from "./authorColor";
import { MentionableTextarea } from "./MentionableTextarea";
import {
  INPUT_BASE,
  PANEL_SURFACE,
  SMALL_PRIMARY_BUTTON,
} from "./surfaceTokens";
import type { Thread } from "./types";

/** How long after creation a pin keeps pulsing to signal "freshly added." */
const FRESH_PIN_MS = 3500;

/**
 * Renders saved pins for a single slide as numbered dots, plus the
 * draft-pin affordance: a clickable "+" that opens an inline composer
 * popover anchored to the pin's location on the slide.
 *
 * Inline composing is the gesture: shift-click drops the "+", click
 * the "+" to write a comment in place — no need to switch focus to
 * the panel. Click outside / Cancel / Esc dismisses without saving.
 *
 * Should be rendered inside the slide's section element so the
 * absolute positions resolve relative to the slide.
 */
export function SlidePinLayer({
  slideId,
  isActive,
  draftPin,
  onClearDraftPin,
  onSelect,
  hoveredThreadId,
}: {
  slideId: string;
  isActive: boolean;
  /** Ghost pin for an in-progress comment (before post). */
  draftPin?: { x: number; y: number } | null;
  /** Called when the draft pin should be dismissed (cancel / post / outside click). */
  onClearDraftPin?: () => void;
  /** Click on a saved pin → bubbles up so the parent can open the panel scrolled to that thread. */
  onSelect?: (threadId: string) => void;
  /** When set, the matching pin highlights — used when the panel's thread card is hovered. */
  hoveredThreadId?: string | null;
}) {
  const { threads, addComment } = useCommentsForSlide(slideId);

  // Held so the portaled inline composer can find the slide section's
  // viewport rect (PinPopover renders at body level to escape the
  // section-scroller's transform; without an anchor like this it would
  // have no way to know where the slide actually sits on screen).
  const layerRef = useRef<HTMLDivElement>(null);

  // Only top-level comments are pinnable. Replies inherit the parent's location.
  const pinnedThreads = useMemo(
    () => threads.filter((t) => t.parent.pin),
    [threads]
  );

  // Hide everything while the slide is transitioning out — pins flying
  // across the viewport reads as visual noise.
  if (!isActive && !draftPin) return null;

  return (
    <div
      ref={layerRef}
      data-print-hide
      className="pointer-events-none absolute inset-0 z-20"
    >
      {pinnedThreads.map((thread, i) => (
        <PinDot
          key={thread.parent.id}
          number={i + 1}
          thread={thread}
          highlighted={hoveredThreadId === thread.parent.id}
          onClick={() => onSelect?.(thread.parent.id)}
        />
      ))}
      {draftPin && (
        <DraftPin
          x={draftPin.x}
          y={draftPin.y}
          layerRef={layerRef}
          onPost={async (bodyText) => {
            await addComment(bodyText, null, draftPin);
            onClearDraftPin?.();
          }}
          onCancel={() => onClearDraftPin?.()}
        />
      )}
    </div>
  );
}

// ─── Saved pin dot ─────────────────────────────────────────────────────

function PinDot({
  number,
  thread,
  highlighted,
  onClick,
}: {
  number: number;
  thread: Thread;
  highlighted?: boolean;
  onClick?: () => void;
}) {
  const pin = thread.parent.pin;
  const isResolved = thread.parent.status === "resolved";

  // "Fresh" = created within the last few seconds. Pulses for that
  // window so anyone watching the deck during a review session sees
  // new pins arrive. Settles into the static state afterward.
  const [isFresh, setIsFresh] = useState(() => {
    const ageMs = Date.now() - new Date(thread.parent.createdAt).getTime();
    return ageMs < FRESH_PIN_MS;
  });
  useEffect(() => {
    if (!isFresh) return;
    const ageMs = Date.now() - new Date(thread.parent.createdAt).getTime();
    const remaining = Math.max(0, FRESH_PIN_MS - ageMs);
    const t = window.setTimeout(() => setIsFresh(false), remaining);
    return () => window.clearTimeout(t);
  }, [isFresh, thread.parent.createdAt]);

  if (!pin) return null;

  // When the panel's thread card is being hovered, scale up + add an
  // outer glow in the author's color so the pin pops against the slide.
  // Effect overrides the fresh-pin pulse so they don't fight.
  const highlightShadow = highlighted
    ? `0 0 0 4px ${tintForAuthor(thread.parent.authorEmail, 0.45)}, 0 0 24px ${tintForAuthor(thread.parent.authorEmail, 0.6)}, 0 2px 8px rgba(0,0,0,0.20)`
    : "0 2px 8px rgba(0,0,0,0.20)";

  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        left: `${pin.x * 100}%`,
        top: `${pin.y * 100}%`,
        backgroundColor: tintForAuthor(thread.parent.authorEmail, 0.95),
        boxShadow: highlightShadow,
      }}
      className={`pointer-events-auto absolute -translate-x-1/2 -translate-y-1/2 inline-flex h-7 w-7 items-center justify-center rounded-full text-[11px] font-semibold text-[#111] ring-2 ring-white/85 transition-all duration-300 hover:scale-110 ${
        highlighted ? "scale-[1.35] z-10" : ""
      } ${isResolved ? "opacity-50" : "opacity-95"} ${
        isFresh && !highlighted ? "animate-pulse" : ""
      }`}
      aria-label={`Open pin ${number}`}
      title={`Pin ${number} — ${thread.parent.authorName}`}
    >
      {number}
    </button>
  );
}

// ─── Draft pin (clickable "+" → expands to composer) ───────────────────

function DraftPin({
  x,
  y,
  layerRef,
  onPost,
  onCancel,
}: {
  x: number;
  y: number;
  layerRef: React.RefObject<HTMLDivElement | null>;
  onPost: (body: string) => Promise<void>;
  onCancel: () => void;
}) {
  const { data: session, status: authStatus } = useSession();
  const [composerOpen, setComposerOpen] = useState(false);

  // Auto-open the composer if the user is already signed in and the
  // pin is freshly placed — feels like one continuous gesture from
  // shift-click → typing. (If they bail, click-outside closes both.)
  useEffect(() => {
    if (authStatus === "authenticated" && session) {
      setComposerOpen(true);
    }
  }, [authStatus, session]);

  return (
    <>
      {!composerOpen && (
        <button
          type="button"
          onClick={() => setComposerOpen(true)}
          style={{ left: `${x * 100}%`, top: `${y * 100}%` }}
          className="pointer-events-auto absolute -translate-x-1/2 -translate-y-1/2 inline-flex h-7 w-7 items-center justify-center rounded-full bg-[#F5F9FE] text-[15px] font-semibold text-[#111] ring-2 ring-[#111] shadow-[0_2px_8px_rgba(0,0,0,0.20)] transition hover:scale-110"
          aria-label="Add comment here"
        >
          +
        </button>
      )}

      {composerOpen && (
        <PinPopover
          x={x}
          y={y}
          layerRef={layerRef}
          onPost={async (body) => {
            await onPost(body);
            setComposerOpen(false);
          }}
          onCancel={() => {
            setComposerOpen(false);
            onCancel();
          }}
        />
      )}
    </>
  );
}

// ─── Inline composer popover ──────────────────────────────────────────

/**
 * Rendered via a React portal at `document.body`, not inside SlidePinLayer.
 *
 * Two reasons:
 *
 *   1. The deck track has CSS `transform: translateY(...)` for the section
 *      stepper. When backdrop-filter (the panel's frosted blur) lives
 *      inside a transformed ancestor, browsers move sampling onto a
 *      different compositing layer and the blur silently fails to render.
 *      Portaling escapes that constraint — same blur recipe as
 *      CommentPanel, same actual pixels.
 *
 *   2. With fixed positioning, no ancestor transforms can knock the
 *      popover off the pin. A resize listener keeps it pinned.
 */
function PinPopover({
  x,
  y,
  layerRef,
  onPost,
  onCancel,
}: {
  x: number;
  y: number;
  layerRef: React.RefObject<HTMLDivElement | null>;
  onPost: (body: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [body, setBody] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  // Cache the slide section's viewport rect — pin coords are normalized
  // to that rect, so we resolve once and refresh on resize/scroll.
  const [sectionRect, setSectionRect] = useState<DOMRect | null>(null);
  useEffect(() => {
    const update = () => {
      const section = layerRef.current?.closest(
        "[data-section]"
      ) as HTMLElement | null;
      if (section) setSectionRect(section.getBoundingClientRect());
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [layerRef]);

  // Click outside the popover (anywhere on the deck) → cancel.
  useEffect(() => {
    const handle = (e: MouseEvent) => {
      const target = e.target as Node;
      if (ref.current?.contains(target)) return;
      // Don't cancel on shift-click — that's about to drop a new pin
      // somewhere else, which is itself a cancel + new draft.
      onCancel();
    };
    // Defer to next tick so the click that opened the composer
    // doesn't immediately close it.
    const id = window.setTimeout(() => {
      document.addEventListener("mousedown", handle);
    }, 0);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener("mousedown", handle);
    };
  }, [onCancel]);

  const submit = async () => {
    if (!body.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await onPost(body);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to post.");
    } finally {
      setSubmitting(false);
    }
  };

  if (!sectionRect) return null;

  const POP_WIDTH = 320;
  const GAP = 20;

  // Pin's actual viewport position (slide top-left + normalized offset).
  const pinX = sectionRect.left + x * sectionRect.width;
  const pinY = sectionRect.top + y * sectionRect.height;

  // Place the popover above the pin if the pin is in the bottom half
  // of the slide, below if in the top half — keeps it on-screen.
  const above = y >= 0.5;

  // Horizontal anchor: snap to a side if the pin is near the slide edge,
  // otherwise center on the pin.
  const horizontalLeft =
    x < 0.2
      ? pinX
      : x > 0.8
        ? pinX - POP_WIDTH
        : pinX - POP_WIDTH / 2;

  const positionStyle: React.CSSProperties = {
    position: "fixed",
    left: Math.max(12, horizontalLeft),
    ...(above
      ? { bottom: window.innerHeight - pinY + GAP }
      : { top: pinY + GAP }),
  };

  return createPortal(
    <div
      ref={ref}
      data-comments-layer
      data-no-drag
      style={positionStyle}
      className="z-[60]"
      // Stop the popover's mousedown from bubbling up and triggering
      // either click-outside-to-cancel or a deck shift-click reset.
      onMouseDown={(e) => e.stopPropagation()}
    >
      {/* Same surface recipe as the main CommentPanel — frosted shell,
          hairline ring, soft drop shadow. Now that we're portaled out
          of the deck track, the backdrop-blur actually renders. Padding
          bumped to p-4 (from p-3) so the popover breathes a bit more. */}
      <div
        className={`w-[320px] max-w-[calc(100vw-3rem)] rounded-2xl p-4 [isolation:isolate] ${PANEL_SURFACE}`}
      >
        <MentionableTextarea
          value={body}
          onChange={setBody}
          onSubmit={submit}
          placeholder="Pin a comment here…  Type @ to mention."
          rows={2}
          autoFocus
          className={`w-full resize-none rounded-xl px-3 py-2 text-[14px] leading-relaxed text-[#111] outline-none transition placeholder:text-[#888] ${INPUT_BASE}`}
        />

        {error && <p className="mt-2 text-[12px] text-red-700">{error}</p>}

        <div className="mt-3 flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="text-[12px] text-[#444] underline-offset-2 transition-colors hover:text-[#111] hover:underline"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!body.trim() || submitting}
            className={SMALL_PRIMARY_BUTTON}
          >
            {submitting ? "Posting…" : "Post"}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
