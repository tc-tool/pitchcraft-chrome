/**
 * Permission gate for slide-status edits (and any future "owner-only"
 * affordance). Reads `NEXT_PUBLIC_DECK_OWNER_EMAILS` — a comma-separated
 * list — and locks edit power to those emails. If the env is empty, falls
 * back to "any user with role = creative on this deck."
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

export function canEditSlideStatus(
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
