/**
 * Human label for a comment's element-anchor `part`.
 *
 * The host tags rendered elements with `data-anchor="<part>"` using dotted
 * paths that mirror the content schema:
 *   "headline"      → "Headline"
 *   "bullet.2"      → "Bullet 3"        (numeric tail is a 0-based index)
 *   "proof.stat"    → "Proof · Stat"
 *
 * Used by the inline composer ("Commenting on Headline") and the thread
 * card chip (⌖ Headline). Chrome stays content-agnostic — it only ever
 * sees the opaque part string and formats it.
 */
export function prettyAnchorPart(part: string): string {
  const segs = part.split(".");
  const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
  // A trailing numeric segment is a 0-based array index → show it 1-based.
  if (segs.length >= 2 && /^\d+$/.test(segs[segs.length - 1])) {
    const idx = Number(segs[segs.length - 1]) + 1;
    const head = segs.slice(0, -1).map(cap).join(" · ");
    return `${head} ${idx}`;
  }
  return segs.map(cap).join(" · ");
}
