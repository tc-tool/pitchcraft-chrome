"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useCommentCountForSlide } from "./useCommentsClient";
import {
  CHROME_PILL_BASE,
  CHROME_PILL_HOVER,
  CHROME_DOCK_ITEM,
  CHROME_DOCK_ITEM_HOVER,
} from "./surfaceTokens";
import { CHROME_DURATION, CHROME_EASE } from "./motion";

/**
 * Per-slide indicator. Pill-shape, light-glass surface — matches the
 * comment panel's palette so the whole tooling reads as one system,
 * even though the deck behind is dark.
 *
 * When there are open threads, the count appears inline in amber where
 * a leading icon would otherwise go — `[ 3  COMMENTS ]`. When the count
 * is zero, the leading slot is empty and the pill just reads `COMMENTS`.
 *
 * Counts top-level open threads only; replies under a parent don't add
 * to the number.
 *
 * Positioning is owned by the parent — DeckRenderer groups this next
 * to the export button into a flex container.
 */
export function CommentBadge({
  slideId,
  onClick,
  bare = false,
}: {
  slideId: string;
  onClick?: () => void;
  /**
   * When true, renders as a transparent dock item (no frosted pill /
   * hover lift) so a surrounding dock container is the only glass. The
   * animated count disc + roll stay identical. Default false →
   * byte-for-byte the original framed pill.
   */
  bare?: boolean;
}) {
  const open = useCommentCountForSlide(slideId);
  const display = open > 99 ? "99+" : String(open);
  // Target width of the disc by digit-count. The disc animates from 0 to
  // this, so the pill grows through real layout flow — no transforms, no
  // distortion of the label.
  const discWidth = open < 10 ? 18 : open < 100 ? 22 : 26;

  // Outer chrome swaps on `bare`; the count internals below are shared.
  // Framed pill keeps no `gap` (the disc's marginRight is the spacing);
  // the bare dock item carries CHROME_DOCK_ITEM's gap, so its disc drops
  // the marginRight (handled below) to avoid double spacing.
  const outerClass = bare
    ? `${CHROME_DOCK_ITEM} ${CHROME_DOCK_ITEM_HOVER}`
    : `inline-flex h-[34px] items-center rounded-full px-4 text-[10px] uppercase font-medium text-[#444] ${CHROME_PILL_BASE} ${CHROME_PILL_HOVER}`;

  return (
    <button
      type="button"
      onClick={onClick}
      data-print-hide
      data-comments-layer
      aria-label={
        open > 0
          ? `Comments — ${open} open thread${open === 1 ? "" : "s"}`
          : "Comments"
      }
      // No `gap` here on purpose in the framed variant — the spacing
      // before the label is the disc's own animated marginRight, so it
      // collapses to nothing when the disc is gone (the pill reads a
      // tight `COMMENTS`). The bare variant uses CHROME_DOCK_ITEM's gap
      // instead.
      className={outerClass}
    >
      {/* Open-thread count — dark filled disc.
          The pill grows/shrinks smoothly because the disc animates its
          real `width` (and right margin) from 0 → target. Animating
          layout width directly — rather than a transform `scale` — means
          the button widens through normal flow and `Comments` glides
          over without any stretch or snap. `overflow-hidden` clips the
          numeral while the disc is mid-grow and powers the roll below.
          The numeral is centered purely by flex (tabular-nums keeps the
          advance stable across digits) — no manual translate nudge,
          which is what was knocking it off-center. */}
      <AnimatePresence initial={false}>
        {open > 0 && (
          <motion.span
            key="count"
            initial={{ width: 0, marginRight: 0, opacity: 0 }}
            // Framed pill has no flex gap, so the disc carries its own 8px
            // marginRight before the label. The bare dock item already has
            // `gap-1.5`, so the disc adds no margin (avoids doubled space).
            animate={{ width: discWidth, marginRight: bare ? 0 : 8, opacity: 1 }}
            exit={{
              width: 0,
              marginRight: 0,
              opacity: 0,
              // Exit collapses + fades a touch quicker than it entered —
              // chrome convention: exits beat entrances.
              transition: {
                duration: CHROME_DURATION.popover,
                ease: CHROME_EASE.exit,
              },
            }}
            transition={{
              // Width + margin drive the smooth pill growth on the snappy
              // popover timing. Opacity gets its own, slightly longer and
              // evenly-eased pass so the circle reads as a genuine fade
              // in/out (carrying the number with it) rather than a hard
              // wipe synced to the width.
              width: { duration: CHROME_DURATION.popover, ease: CHROME_EASE.standard },
              marginRight: { duration: CHROME_DURATION.popover, ease: CHROME_EASE.standard },
              opacity: { duration: CHROME_DURATION.panel, ease: CHROME_EASE.standard },
            }}
            className="relative inline-flex h-[18px] shrink-0 items-center justify-center overflow-hidden rounded-full bg-[#111] text-[10px] font-semibold leading-none tabular-nums text-white ring-1 ring-white/15 shadow-[inset_0_1px_0_rgba(255,255,255,0.18)]"
          >
            {/* The number rolls: a new value enters from below as the old
                one slides up and out (clipped by the disc's
                overflow-hidden). `initial={false}` so the first value
                just appears with the disc; later increments roll. Keyed
                on the display string so 100→101 doesn't re-roll "99+". */}
            <AnimatePresence initial={false} mode="popLayout">
              <motion.span
                key={display}
                initial={{ y: 9, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                exit={{ y: -9, opacity: 0 }}
                transition={{
                  duration: CHROME_DURATION.thread,
                  ease: CHROME_EASE.standard,
                }}
                className="block text-center leading-none tabular-nums"
              >
                {display}
              </motion.span>
            </AnimatePresence>
          </motion.span>
        )}
      </AnimatePresence>
      <span>Comments</span>
    </button>
  );
}
