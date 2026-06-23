/**
 * Curator gate — the "only the owner can drive this deck" check.
 *
 * Reads `NEXT_PUBLIC_DECK_OWNER_EMAILS` (comma-separated emails) and
 * locks high-trust actions to those emails. There is NO fall-open path:
 * a high-trust action is granted only to a VERIFIED TEAM IDENTITY — an
 * email in the owner allowlist, or a verified toolofna.com Google
 * account (the `isVerifiedTeam` signal, computed server-side from the
 * Google profile's `hd` + `email_verified` claims; see authConfig.ts).
 * A self-declared role is never sufficient on its own.
 *
 * Used to gate:
 *   - Triaging comments (queued ↔ unqueued)
 *   - Compiling the queue → Claude prompt
 *   - Publishing the deck (deck.content.ts snapshot → production)
 *
 * NEXT_PUBLIC_ prefix means the value is inlined into the client bundle,
 * so both server route handlers and client components read the same
 * source of truth.
 *
 * IMPORTANT — server vs. client:
 *   - Client components pass only `{ email, role }` for *UI gating*
 *     (hiding affordances). The owner allowlist alone drives that, since
 *     `NEXT_PUBLIC_DECK_OWNER_EMAILS` is inlined into the client bundle.
 *   - Server route handlers MUST pass the verified-team signal
 *     (`{ isVerifiedTeam }`) so a verified toolofna.com creative who is
 *     not explicitly listed can still curate, while a self-assigned role
 *     on a non-team Google account can NEVER unlock these actions.
 */

/** Domain whose verified Google accounts count as team by default. */
export const TEAM_DOMAIN = "toolofna.com";

/**
 * Optional server-trusted signals. `isVerifiedTeam` is true only when the
 * server has confirmed (from the OAuth profile, re-checked) that the
 * email is a verified team identity — a real toolofna.com account. Client
 * callers omit this; they rely on the owner allowlist for UI gating.
 */
export interface PermissionContext {
  isVerifiedTeam?: boolean;
}

export function deckOwnerEmails(): string[] {
  return (process.env.NEXT_PUBLIC_DECK_OWNER_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/** True if the email is explicitly listed as a deck owner. */
export function isDeckOwner(email: string | null | undefined): boolean {
  if (!email) return false;
  const owners = deckOwnerEmails();
  return owners.length > 0 && owners.includes(email.toLowerCase());
}

/**
 * Pure domain check — does the email sit on the team domain? This is NOT
 * proof of identity by itself (an attacker can claim any email); it's
 * only meaningful when combined with the server's `isVerifiedTeam`
 * signal, which is derived from the verified Google `hd` claim.
 */
export function isTeamDomainEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return email.toLowerCase().endsWith(`@${TEAM_DOMAIN}`);
}

/**
 * Server-authoritative "is this a verified team identity" gate. A
 * verified team member is either an explicitly-allowlisted owner, or a
 * Google account the server confirmed is on the team domain
 * (`isVerifiedTeam`). Never trusts a self-declared role.
 *
 * This is the gate the route handlers use before granting any team
 * privilege (creative/producer role, curation, reorder, dispatch,
 * publish, internal-comment visibility).
 */
export function isVerifiedTeamIdentity(
  email: string | null | undefined,
  ctx?: PermissionContext
): boolean {
  if (!email) return false;
  if (isDeckOwner(email)) return true;
  return ctx?.isVerifiedTeam === true;
}

export function canCurate(
  email: string | null | undefined,
  role: string | null | undefined,
  ctx?: PermissionContext
): boolean {
  if (!email) return false;
  // Owners can always curate.
  if (isDeckOwner(email)) return true;
  // Otherwise a verified team identity acting as creative may curate.
  // NOTE: never fall open. With no owner allowlist AND no verified-team
  // signal, this denies — a self-assigned "creative" alone never unlocks
  // curation.
  return isVerifiedTeamIdentity(email, ctx) && role === "creative";
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
 * This is a TEAM capability: a self-assigned producer on an outside
 * Google account must not be able to reorder slides or attach case
 * studies. So, like `canCurate`, this requires a verified team identity
 * (owner allowlist or verified toolofna.com account) in addition to the
 * creative/producer role. It is purposely NOT restricted to the owner
 * allowlist alone (producers aren't owners), but it never falls open to
 * a bare self-declared role.
 */
export function canReorderSlides(
  email: string | null | undefined,
  role: string | null | undefined,
  ctx?: PermissionContext
): boolean {
  if (!email) return false;
  if (isDeckOwner(email)) return true;
  return (
    isVerifiedTeamIdentity(email, ctx) &&
    (role === "creative" || role === "producer")
  );
}
