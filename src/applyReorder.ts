/**
 * Apply a producer reorder overlay to a source slide list.
 *
 * The chrome doesn't know what shape a slide is — it just knows that
 * each slide has an `id`. This is generic so the host can pass its own
 * `DeckSlide[]` (or any other id-bearing shape) without leaking schema
 * into the chrome package.
 *
 * Resilience rules:
 *
 * 1. **Overlay is null** → return source unchanged. No overlay = no
 *    intent expressed. Fall through to source order.
 *
 * 2. **An id in the overlay is missing from source** → silently skip.
 *    The overlay was made when that slide existed; the creative has
 *    since deleted it. The overlay isn't "wrong," it's just stale on
 *    that one entry.
 *
 * 3. **A slide in source is not in the overlay** → append at the end of
 *    the overlay-driven sequence. This is the new-slide-added-after-
 *    overlay case. The producer didn't have an opinion on it; we don't
 *    invent one. The creative or producer can re-position it later.
 *
 * 4. **Empty overlay (`[]`)** → equivalent to "produced reorder of zero
 *    slides," so every source slide is "new" and ends up in source order.
 *    Effectively a no-op. We never want a reorder to make slides vanish.
 *
 * Pure, no side effects — safe to call on every render.
 */
export function applyReorder<T extends { id: string }>(
  slides: readonly T[],
  overlay: readonly string[] | null
): readonly T[] {
  if (!overlay) return slides;

  const byId = new Map<string, T>();
  for (const s of slides) byId.set(s.id, s);

  // Walk the overlay first — overlay positions win.
  const result: T[] = [];
  const seen = new Set<string>();
  for (const id of overlay) {
    const slide = byId.get(id);
    if (slide && !seen.has(id)) {
      result.push(slide);
      seen.add(id);
    }
  }

  // Append any source slides that the overlay didn't mention.
  for (const s of slides) {
    if (!seen.has(s.id)) result.push(s);
  }

  return result;
}
