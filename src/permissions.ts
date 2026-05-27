/**
 * Curator gate — the "only the owner can drive this deck" check.
 *
 * Reads `NEXT_PUBLIC_DECK_OWNER_EMAILS` (comma-separated emails) and
 * locks high-trust actions to those emails. If the env is empty, falls
 * back to "any user with role = creative on this deck."
 *
 * Used to gate:
 *   - Triaging comments (queued ↔ unqueued)
 *   - Compiling the queue → Claude prompt
 *   - Publishing the deck (deck.content.ts snapshot → production)
 *
 * NEXT_PUBLIC_ prefix means the value is inlined into the client bundle,
 * so both server route handlers and client components read the same
 * source of truth.
 */

export function deckOwnerEmails(): string[] {
  return (process.env.NEXT_PUBLIC_DECK_OWNER_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export function canCurate(
  email: string | null | undefined,
  role: string | null | undefined
): boolean {
  if (!email) return false;
  const owners = deckOwnerEmails();
  if (owners.length > 0) {
    return owners.includes(email.toLowerCase());
  }
  return role === "creative";
}

/**
 * Back-compat alias — the old name was tied to the slide-status pill,
 * which is being removed. New callers should use `canCurate`. The
 * alias stays for one release so external decks updating in lockstep
 * don't break; remove in the next major bump.
 *
 * @deprecated use `canCurate` instead
 */
export const canEditSlideStatus = canCurate;

/**
 * Slide reordering — broader than slide-status. Producers own the
 * narrative arc, so they can reorder slides too. Creatives also can
 * (for their own iteration). Clients are read-only.
 *
 * Note this is purposely *not* gated by deckOwnerEmails — that env var
 * is the lock for "only the owner can change slide status." Reorder
 * is a producer-friendly capability by design.
 */
export function canReorderSlides(
  email: string | null | undefined,
  role: string | null | undefined
): boolean {
  if (!email) return false;
  return role === "creative" || role === "producer";
}
