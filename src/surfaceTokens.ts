/**
 * Centralized surface tokens for the comments module.
 *
 * The CommentPanel (the right-side sheet) and the SlidePinLayer's inline
 * pin popover are siblings of the same UI language — frosted off-white
 * over the dark deck, hairline rings, soft drop shadow, dark primary
 * button. Defining the recipes here means a future visual change to one
 * surface auto-propagates to the other; the panel and the pin chrome
 * never drift apart.
 */

// Chrome palette: black & white with a subtle blue tint.
// rgba(244, 249, 254, X) — R is 10 below B, near-max-bright but tilted
// cool. Replaces the previous warm (250,250,248) values across all
// chrome surfaces. Brightness is preserved; the tint axis is reversed
// from yellow-warm to blue-cool.

/** Translucent frosted-glass shell. Used by the panel and the pin popover. */
export const PANEL_SURFACE =
  "bg-[rgba(244,249,254,0.66)] ring-1 ring-black/[0.06] backdrop-blur-xl backdrop-saturate-150 shadow-[inset_0_1px_0_rgba(255,255,255,0.7),0_12px_40px_rgba(0,0,0,0.10)]";

/** Hairline ring + soft top-edge highlight for tinted comment cards. */
export const CARD_RING_AND_LIFT =
  "ring-1 ring-black/[0.06] shadow-[inset_0_1px_0_rgba(255,255,255,0.4)]";

/**
 * Recessed input surface — composer, reply, edit, pin popover.
 *
 * Subtractive tint (not a brighter solid) so the input reads as a *well
 * pressed into the panel* rather than a separate white card placed on
 * top. Focus state is deliberately a *no-op* — no ring change, no bg
 * change, no outline. The textarea looks identical focused vs.
 * unfocused; the blinking caret inside is the focus indicator. Any
 * visual change on click was reading as the box morphing, which is the
 * thing we're avoiding.
 */
export const INPUT_BASE =
  "bg-black/[0.05] ring-1 ring-black/[0.08] shadow-[inset_0_1px_2px_rgba(0,0,0,0.04)]";

/**
 * Full-size dark primary button — main composer's "Post comment".
 *
 * `active:scale-[0.98]` gives a brief compression on press; combined
 * with the GPU-friendly transform it reads as a tactile click without
 * any layout shift. Duration is tied to the hover/press constants in
 * lib/motion/chrome.ts (150ms hover, 100ms press) so the release
 * snaps back faster than the tonal change settles.
 */
export const PRIMARY_BUTTON =
  "rounded-full bg-[#111] px-5 py-2 text-[13px] font-medium text-white transition-[background-color,transform] duration-150 ease-out hover:bg-black active:scale-[0.98] active:duration-100 disabled:cursor-not-allowed disabled:bg-black/10 disabled:text-black/30 disabled:active:scale-100";

/** Compact dark primary button — replies, edits, and pin popover Post. */
export const SMALL_PRIMARY_BUTTON =
  "rounded-full bg-[#111] px-4 py-1.5 text-[12px] font-medium text-white transition-[background-color,transform] duration-150 ease-out hover:bg-black active:scale-[0.98] active:duration-100 disabled:cursor-not-allowed disabled:bg-black/10 disabled:text-black/30 disabled:active:scale-100";

/**
 * Frosted-glass pill surface for the persistent slide chrome — status
 * pill, comment badge, export PDF. Same primary color and ring as the
 * comment panel (PANEL_SURFACE) so all the tooling reads as one system,
 * just at pill scale instead of panel scale (smaller drop shadow).
 *
 * Sits over the dark deck; backdrop-blur + saturate keep the surface
 * frosted instead of looking like a flat overlay.
 */
export const CHROME_PILL_BASE =
  "bg-[rgba(244,249,254,0.66)] ring-1 ring-black/[0.06] backdrop-blur-xl backdrop-saturate-150 shadow-[inset_0_1px_0_rgba(255,255,255,0.7),0_2px_8px_rgba(0,0,0,0.10)]";

/**
 * Hover lift — applies on top of CHROME_PILL_BASE for interactive pills.
 *
 * Hover lifts 0.5 (1.5px), ring + shadow intensify. On press, the lift
 * collapses (active:translate-y-0) so the pill reads as physically
 * compressed for the duration of the click. Press transition is tied
 * to the press duration constant — fast enough to feel like a tap.
 */
export const CHROME_PILL_HOVER =
  "transition-[transform,background-color,box-shadow,color] duration-150 ease-out hover:-translate-y-0.5 hover:bg-[rgba(244,249,254,0.82)] hover:text-[#111] hover:ring-black/[0.20] hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.8),0_8px_22px_rgba(0,0,0,0.14)] active:translate-y-0 active:duration-100 active:shadow-[inset_0_1px_0_rgba(255,255,255,0.7),0_2px_8px_rgba(0,0,0,0.10)]";
