/**
 * Stable per-author color.
 *
 * Hashes the email → index into a curated 6-tone palette. Same email
 * always gets the same color; no state to manage, no UI to assign.
 *
 * The palette intentionally avoids amber and emerald — those carry
 * semantic meaning elsewhere in the system (review status, approved
 * status, notification counts). Author colors are decorative-only and
 * must never be confused for status.
 *
 * Six colors is enough for ~95% of decks. Beyond that, the palette
 * wraps and two people share a color — fine, names still differentiate
 * them.
 */

const PALETTE = [
  "#F472B6", // pink-400
  "#FB923C", // orange-400
  "#5EEAD4", // teal-300
  "#7DD3FC", // sky-300
  "#A5B4FC", // indigo-300
  "#C4B5FD", // violet-300
] as const;

export const AUTHOR_PALETTE: readonly string[] = PALETTE;

export function colorForAuthor(email: string | null | undefined): string {
  if (!email) return PALETTE[0];
  const lower = email.toLowerCase();
  let hash = 0;
  for (let i = 0; i < lower.length; i++) {
    // 31x prime, force i32 with `| 0`
    hash = (hash * 31 + lower.charCodeAt(i)) | 0;
  }
  return PALETTE[Math.abs(hash) % PALETTE.length];
}

/**
 * Same color as `colorForAuthor`, but as a low-alpha rgba string so it
 * can be used as a background on dark surfaces. The result is a subtle
 * haze that reads as "this comment is from <person>" without screaming.
 *
 * Default alpha (0.10) is tuned for comment cards. The composer uses a
 * lighter (~0.06) wash so it doesn't dominate while you're typing.
 */
export function tintForAuthor(
  email: string | null | undefined,
  alpha = 0.1
): string {
  const color = colorForAuthor(email);
  const r = parseInt(color.slice(1, 3), 16);
  const g = parseInt(color.slice(3, 5), 16);
  const b = parseInt(color.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
