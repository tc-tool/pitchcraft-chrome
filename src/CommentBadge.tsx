"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useCommentCountForSlide } from "./useCommentsClient";
import { CHROME_PILL_BASE, CHROME_PILL_HOVER } from "./surfaceTokens";
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
}: {
  slideId: string;
  onClick?: () => void;
}) {
  const open = useCommentCountForSlide(slideId);
  const display = open > 99 ? "99+" : String(open);
  // Target width of the disc by digit-count. The disc animates from 0 to
  // this, so the pill grows through real layout flow — no transforms, no
  // distortion of the label.
  const discWidth = open < 10 ? 18 : open < 100 ? 22 : 26;

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
      // No `gap` here on purpose — the spacing before the label is the
      // disc's own animated marginRight, so it collapses to nothing when
      // the disc is gone (the pill reads a tight `COMMENTS`).
      className={`inline-flex h-[34px] items-center rounded-full px-4 text-[10px] uppercase font-medium text-[#444] ${CHROME_PILL_BASE} ${CHROME_PILL_HOVER}`}
    >
      {/* Open-thread count — dark filled disc.
          The pill grows/shrinks smoothly because the disc animates its
          real `width` (and right margin) from 0 → target. Animating
          layout width directly — rather than a transform `scale` — means
          the button widens through normal flow and `Comments` glides
          over without any stretch or snap. `overflow-hidden` clips the
          numeral while the disc is mid-grow and powers the roll below.
          tabular-nums + the 1.5px nudge handle Suisse Intl's
          left-leaning numeral sidebearings. */}
      <AnimatePresence initial={false}>
        {open > 0 && (
          <motion.span
            key="count"
            initial={{ width: 0, marginRight: 0, opacity: 0 }}
            animate={{ width: discWidth, marginRight: 8, opacity: 1 }}
            exit={{ width: 0, marginRight: 0, opacity: 0 }}
            transition={{
              duration: CHROME_DURATION.popover,
              ease: CHROME_EASE.standard,
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
                className="block translate-x-[1.5px] tabular-nums"
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
