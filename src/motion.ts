/**
 * Motion language for the comment + slide chrome.
 *
 * The deck spine has its own constants in ./constants.ts (SECTION_TRAVEL,
 * REVEAL). Those govern slide transitions. *This* file governs the
 * surrounding chrome — comment panel, pills, popovers, dropdowns,
 * micro-interactions on hover/press/focus.
 *
 * Keep these tight and reused. Scattering ad-hoc duration: 0.2s and
 * ease: [0.22, 1, 0.36, 1] across 12 components is what makes a UI
 * feel "designed by committee." Pick once, share everywhere.
 *
 * Easing rationale: [0.22, 1, 0.36, 1] is ease-out-quart — a snappy
 * release that lets the user feel the motion settle without any rebound.
 * Used by both the deck and the chrome so the two systems share a voice.
 */

/** Easing curves — bezier control points consumed by Framer Motion + CSS. */
export const CHROME_EASE = {
  /** Default for entrances and state changes. Snappy out, soft settle. */
  standard: [0.22, 1, 0.36, 1] as const,
  /** Faster out for exits — exits should always be slightly quicker than entrances. */
  exit: [0.4, 0, 1, 1] as const,
} as const;

/**
 * Durations in seconds (for Framer Motion) — paired Tailwind class names
 * are exported below for CSS transitions.
 */
export const CHROME_DURATION = {
  /** Hover feedback, tonal shifts. Anything that should feel instant. */
  hover: 0.16,
  /** Press / tap compression. Faster than hover so the release feels crisp. */
  press: 0.10,
  /** Counter / micro typography swaps. */
  micro: 0.18,
  /** Tooltip / popover / mention typeahead entrance. */
  popover: 0.22,
  /** Comment thread enter/exit, edit-mode swap. */
  thread: 0.24,
  /** Comment panel + drawer entrance. */
  panel: 0.28,
  /** Pill cluster stagger interval. */
  staggerGap: 0.08,
  /** Pill cluster initial delay before the staggered entrance starts. */
  staggerLeadIn: 0.45,
} as const;

/** Tailwind duration class names — match CHROME_DURATION values. */
export const CHROME_DURATION_CLASS = {
  hover: "duration-150",
  press: "duration-100",
  popover: "duration-200",
  thread: "duration-[240ms]",
  panel: "duration-300",
} as const;
