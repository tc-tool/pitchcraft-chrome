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
      className={`inline-flex h-[34px] items-center gap-2 rounded-full px-4 text-[10px] uppercase tracking-[0.26em] text-[#444] ${CHROME_PILL_BASE} ${CHROME_PILL_HOVER}`}
    >
      {/* Open-thread count — dark filled disc.
          Fixed widths per digit-count keep the box a true square /
          stadium so centering doesn't drift. tabular-nums on the
          fixed cell + the 1.5px optical nudge handles Suisse Intl's
          left-leaning sidebearings on numerals.
          AnimatePresence makes the disc scale-in when the count
          crosses 0 → 1 (and scale-out when it returns to 0) instead
          of snapping in. The disc stays mounted across n→n+1 changes
          because the key is constant. */}
      <AnimatePresence initial={false}>
        {open > 0 && (
          <motion.span
            key="count"
            initial={{ scale: 0.5, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.5, opacity: 0 }}
            transition={{
              duration: CHROME_DURATION.popover,
              ease: CHROME_EASE.standard,
            }}
            className={`inline-flex h-[18px] items-center justify-center rounded-full bg-[#111] text-[10px] font-semibold leading-none tabular-nums text-white ring-1 ring-white/15 shadow-[inset_0_1px_0_rgba(255,255,255,0.18)] ${
              open < 10 ? "w-[18px]" : open < 100 ? "w-[22px]" : "w-[26px]"
            }`}
          >
            <span className="translate-x-[1.5px]">
              {open > 99 ? "99+" : open}
            </span>
          </motion.span>
        )}
      </AnimatePresence>
      <span>Comments</span>
    </button>
  );
}
