import { NextRequest, NextResponse } from "next/server";
import { auth, sessionIsVerifiedTeam } from "./authConfig";
import { notifySlackMention } from "./notifySlack";
import {
  canCurate,
  canReorderSlides,
  isVerifiedTeamIdentity,
} from "./permissions";
import { getStore } from "./store";
import type { Comment, CommentAnchor, CommentRole, CommentStatus } from "./types";

/**
 * deckId is interpolated directly into Redis key namespaces
 * (`comments:{deckId}:…`). A deckId containing `:` (or other separators)
 * could collide with or escape its namespace on a shared Redis. Decks are
 * created by the factory from a URL-safe slug, so a strict slug regex is
 * the right shape. Validate at every route entry before the value can
 * reach the store.
 */
const DECK_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

export function isValidDeckId(deckId: unknown): deckId is string {
  return (
    typeof deckId === "string" &&
    deckId.length > 0 &&
    deckId.length <= 100 &&
    DECK_ID_RE.test(deckId)
  );
}

/**
 * Pull `<@email>` tokens out of a comment body, dedupe, lowercase.
 * The server treats this as authoritative regardless of how the client
 * built the body — gives `mentions` a single source of truth.
 */
function extractMentions(body: string): string[] {
  const re = /<@([^>\s]+)>/g;
  const found = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    found.add(m[1].toLowerCase());
  }
  return Array.from(found);
}

/**
 * Validate a richer comment anchor from the client. Returns a clean
 * CommentAnchor or null (→ the comment falls back to slide-level / pin).
 * Chrome stays content-agnostic: it only checks shape + numeric ranges,
 * never what `part` means or whether `quote` matches anything.
 */
function validateAnchor(raw: unknown): CommentAnchor | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as {
    scope?: string;
    part?: unknown;
    rect?: unknown;
    quote?: unknown;
  };
  const quote =
    typeof a.quote === "string" && a.quote.trim()
      ? a.quote.trim().slice(0, 280)
      : undefined;

  if (a.scope === "slide") return { scope: "slide" };

  if (a.scope === "element" && typeof a.part === "string" && a.part.trim()) {
    return {
      scope: "element",
      part: a.part.trim().slice(0, 120),
      ...(quote ? { quote } : {}),
    };
  }

  if (a.scope === "region" && a.rect && typeof a.rect === "object") {
    const r = a.rect as Record<string, unknown>;
    const x = Number(r.x);
    const y = Number(r.y);
    const w = Number(r.w);
    const h = Number(r.h);
    const inRange = (n: number) => Number.isFinite(n) && n >= 0 && n <= 1;
    if ([x, y, w, h].every(inRange)) {
      return { scope: "region", rect: { x, y, w, h }, ...(quote ? { quote } : {}) };
    }
  }

  return null;
}

/**
 * Route handlers the host wires into:
 *
 *   app/api/comments/route.ts        → GET / POST / PATCH
 *   app/api/comments/me/route.ts     → meGET / mePOST
 *
 * `deckId` is required on every call. Identity comes from the NextAuth
 * session (verified Google email). The user's role is stored once per
 * deck via mePOST; commentsPOST then auto-stamps every new comment
 * with the stored role — no per-comment toggle.
 */

const VALID_ROLES: CommentRole[] = ["creative", "producer", "client"];
const VALID_STATUSES: CommentStatus[] = ["open", "resolved"];

/**
 * Resolve the deck's public base URL for outbound links (e.g. the
 * "Open in deck" link in a Slack DM). Prefer a server-trusted env
 * constant the factory already sets — the request Host / X-Forwarded-*
 * headers are attacker-controllable and must not decide where a link in
 * a trusted internal message points. Fall back to request headers only
 * when no env is configured (local dev).
 */
export function resolveDeckBaseUrl(req: NextRequest): string {
  const fromEnv =
    process.env.NEXT_PUBLIC_DECK_URL ??
    process.env.AUTH_URL ??
    process.env.NEXTAUTH_URL;
  if (fromEnv && fromEnv.trim()) {
    return fromEnv.trim().replace(/\/+$/, "") + "/";
  }
  // Local-dev fallback only: derive from request headers.
  const proto =
    req.headers.get("x-forwarded-proto") ??
    (req.url.startsWith("https") ? "https" : "http");
  const host = req.headers.get("host") ?? "localhost:3000";
  return `${proto}://${host}/`;
}

// ─── Comments collection ───────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const deckId = url.searchParams.get("deckId");
  const slideId = url.searchParams.get("slideId") ?? undefined;

  if (!isValidDeckId(deckId)) {
    return NextResponse.json({ error: "invalid deckId" }, { status: 400 });
  }

  // Audience gate (no-leak): only the team sees internal comments.
  // Clients and anonymous viewers get client-visible comments only — and
  // a legacy comment with no `audience` counts as internal, so old
  // internal notes never surface on the client link.
  //
  // "Team" here is a VERIFIED team identity (owner allowlist or a
  // verified toolofna.com Google account), not a self-declared role — a
  // non-team Google account that set its role to creative/producer must
  // never read internal threads.
  const session = await auth();
  let isTeam = false;
  if (session?.user?.email) {
    isTeam = isVerifiedTeamIdentity(session.user.email, {
      isVerifiedTeam: sessionIsVerifiedTeam(session),
    });
  }

  const comments = await getStore().list(deckId, slideId);
  const visible = isTeam
    ? comments
    : comments.filter((c) => (c.audience ?? "internal") === "client");
  return NextResponse.json({ comments: visible });
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "auth required" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  const {
    deckId,
    slideId,
    body: commentBody,
    parentId,
    pin,
    anchor: anchorRaw,
    surface,
    anchorContentHash,
    anchorVersion,
  } = body as {
    deckId?: string;
    slideId?: string;
    body?: string;
    parentId?: string | null;
    pin?: { x?: number; y?: number } | null;
    anchor?: unknown;
    surface?: string;
    anchorContentHash?: string;
    anchorVersion?: string;
  };

  if (!deckId || !slideId || !commentBody?.trim()) {
    return NextResponse.json(
      { error: "deckId, slideId, body required" },
      { status: 400 }
    );
  }
  if (!isValidDeckId(deckId)) {
    return NextResponse.json({ error: "invalid deckId" }, { status: 400 });
  }

  // Validate pin if supplied — both coords must be finite numbers in [0,1].
  // Replies don't get pins (only the top-level thread carries a location).
  let validatedPin: { x: number; y: number } | null = null;
  if (pin && !parentId) {
    const x = Number(pin.x);
    const y = Number(pin.y);
    const inRange = (n: number) => Number.isFinite(n) && n >= 0 && n <= 1;
    if (!inRange(x) || !inRange(y)) {
      return NextResponse.json({ error: "pin out of range" }, { status: 400 });
    }
    validatedPin = { x, y };
  }

  // Richer anchor (element / region / slide). Like pins, only top-level
  // comments carry one — replies inherit the thread's.
  const validatedAnchor = parentId ? null : validateAnchor(anchorRaw);

  // Look up the user's stored role. If they haven't picked yet, reject —
  // the client should have shown the role picker first.
  const userRecord = await getStore().getUser(deckId, session.user.email);
  if (!userRecord) {
    return NextResponse.json(
      { error: "role not set", code: "no_role" },
      { status: 409 }
    );
  }

  // Audience is derived from the verified role — never trusted from the
  // client. A client's comment is client-visible; team comments default
  // to internal (the creative can surface one later via PATCH).
  const audience: "internal" | "client" =
    userRecord.role === "client" ? "client" : "internal";
  const origin =
    surface === "production" || surface === "staging" ? surface : undefined;

  const trimmedBody = commentBody.trim().slice(0, 4000);
  const mentions = extractMentions(trimmedBody);

  const comment: Comment = {
    id: crypto.randomUUID(),
    deckId,
    slideId,
    parentId: parentId ?? null,
    body: trimmedBody,
    authorEmail: session.user.email,
    authorName: session.user.name ?? userRecord.name ?? session.user.email,
    authorImage: session.user.image ?? undefined,
    role: userRecord.role,
    status: "open",
    audience,
    createdAt: new Date().toISOString(),
    ...(mentions.length > 0 ? { mentions } : {}),
    ...(validatedPin ? { pin: validatedPin } : {}),
    ...(validatedAnchor ? { anchor: validatedAnchor } : {}),
    ...(origin ? { origin } : {}),
    ...(typeof anchorContentHash === "string"
      ? { anchorContentHash: anchorContentHash.slice(0, 128) }
      : {}),
    ...(typeof anchorVersion === "string"
      ? { anchorVersion: anchorVersion.slice(0, 64) }
      : {}),
  };

  await getStore().create(comment);

  // Slack notification for @mentions — fire-and-forget. Don't block the
  // response on this; if Slack is down or the bot isn't configured,
  // commenting still works. We gate ONLY on the bot token (SLACK_CHANNEL
  // is optional — when unset, notifySlackMention runs in DM mode and
  // pings each mentioned user directly. Requiring SLACK_CHANNEL here
  // would silently disable DM mode entirely).
  //
  // Diagnostics for failed email→Slack-ID lookups (missing scope, wrong
  // email, revoked token) are logged SERVER-SIDE only by notifySlack.
  // We must NOT return Slack member IDs, ok flags, or raw Slack error
  // strings to the comment author: that's reconnaissance for targeted
  // phishing. The response carries only the created comment.
  if (mentions.length > 0 && process.env.SLACK_BOT_TOKEN) {
    console.log(
      `[notifySlack] firing for ${mentions.length} mention(s) on comment ${comment.id} (mode=${process.env.SLACK_CHANNEL?.trim() ? "channel" : "dm"})`
    );

    // Real send — fire-and-forget.
    void (async () => {
      try {
        const allUsers = await getStore().listUsers(deckId);
        const byEmail = new Map(
          allUsers.map((u) => [u.email.toLowerCase(), u])
        );
        const mentionedDisplay = mentions.map(
          (email) => byEmail.get(email)?.name ?? email
        );

        await notifySlackMention({
          comment,
          // Chrome stays neutral on the host's content schema — we use
          // deckId as a stable identifier. Hosts that want a friendlier
          // title in Slack can wrap the route handler and override this.
          deckTitle: deckId,
          deckUrl: resolveDeckBaseUrl(req),
          mentionedEmails: mentions,
          mentionedDisplay,
        });
      } catch (e) {
        console.warn("[notifySlack] resolution failed", e);
      }
    })();
  } else if (mentions.length > 0) {
    console.log(
      `[notifySlack] skipped — SLACK_BOT_TOKEN not set (had ${mentions.length} mention(s))`
    );
  }

  return NextResponse.json({ comment }, { status: 201 });
}

export async function PATCH(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "auth required" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  const {
    deckId,
    commentId,
    status,
    body: newBody,
    queued,
    audience,
  } = body as {
    deckId?: string;
    commentId?: string;
    status?: string;
    body?: string;
    queued?: boolean;
    audience?: string;
  };

  if (!deckId || !commentId) {
    return NextResponse.json(
      { error: "deckId and commentId required" },
      { status: 400 }
    );
  }
  if (!isValidDeckId(deckId)) {
    return NextResponse.json({ error: "invalid deckId" }, { status: 400 });
  }

  const teamCtx = { isVerifiedTeam: sessionIsVerifiedTeam(session) };

  // PATCH modes: body edit (own comment only), queue toggle
  // (creative-only), audience toggle (creative-only), or status change.
  // The more-specific fields are checked first; status falls through as
  // the default.
  if (typeof queued === "boolean") {
    const userRecord = await getStore().getUser(deckId, session.user.email);
    if (!canCurate(session.user.email, userRecord?.role, teamCtx)) {
      return NextResponse.json({ error: "not authorized" }, { status: 403 });
    }
    const updated = await getStore().setQueued(deckId, commentId, queued);
    if (!updated) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    return NextResponse.json({ comment: updated });
  }

  // Surface an internal comment to the client, or retract one. Creative
  // only — controlling what the client sees is a publish-adjacent act.
  if (typeof audience === "string") {
    if (audience !== "internal" && audience !== "client") {
      return NextResponse.json({ error: "invalid audience" }, { status: 400 });
    }
    const userRecord = await getStore().getUser(deckId, session.user.email);
    if (!canCurate(session.user.email, userRecord?.role, teamCtx)) {
      return NextResponse.json({ error: "not authorized" }, { status: 403 });
    }
    const updated = await getStore().setVisibility(deckId, commentId, audience);
    if (!updated) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    return NextResponse.json({ comment: updated });
  }

  if (typeof newBody === "string") {
    const trimmed = newBody.trim();
    if (!trimmed) {
      return NextResponse.json({ error: "body cannot be empty" }, { status: 400 });
    }

    const existing = await getStore().get(deckId, commentId);
    if (!existing) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    if (existing.authorEmail.toLowerCase() !== session.user.email.toLowerCase()) {
      return NextResponse.json({ error: "not your comment" }, { status: 403 });
    }

    const clipped = trimmed.slice(0, 4000);
    const mentions = extractMentions(clipped);
    const updated = await getStore().updateBody(deckId, commentId, clipped, mentions);

    if (!updated) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    return NextResponse.json({ comment: updated });
  }

  if (!status) {
    return NextResponse.json(
      { error: "status or body required" },
      { status: 400 }
    );
  }

  if (!(VALID_STATUSES as string[]).includes(status)) {
    return NextResponse.json({ error: "invalid status" }, { status: 400 });
  }

  const updated = await getStore().setStatus(
    deckId,
    commentId,
    status as CommentStatus,
    session.user.email
  );

  if (!updated) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  return NextResponse.json({ comment: updated });
}

export async function DELETE(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "auth required" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  const { deckId, commentId } = body as {
    deckId?: string;
    commentId?: string;
  };

  if (!deckId || !commentId) {
    return NextResponse.json(
      { error: "deckId and commentId required" },
      { status: 400 }
    );
  }
  if (!isValidDeckId(deckId)) {
    return NextResponse.json({ error: "invalid deckId" }, { status: 400 });
  }

  const existing = await getStore().get(deckId, commentId);
  if (!existing) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (existing.authorEmail.toLowerCase() !== session.user.email.toLowerCase()) {
    return NextResponse.json({ error: "not your comment" }, { status: 403 });
  }

  await getStore().delete(deckId, commentId);
  return NextResponse.json({ ok: true });
}

// ─── Me — per-deck role ────────────────────────────────────────────────

export async function meGET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ user: null });
  }

  const url = new URL(req.url);
  const deckId = url.searchParams.get("deckId");
  if (!isValidDeckId(deckId)) {
    return NextResponse.json({ error: "invalid deckId" }, { status: 400 });
  }

  const user = await getStore().getUser(deckId, session.user.email);
  return NextResponse.json({ user });
}

export async function mePOST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "auth required" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  const { deckId, role } = body as { deckId?: string; role?: string };

  if (!deckId || !role) {
    return NextResponse.json(
      { error: "deckId and role required" },
      { status: 400 }
    );
  }
  if (!isValidDeckId(deckId)) {
    return NextResponse.json({ error: "invalid deckId" }, { status: 400 });
  }

  if (!(VALID_ROLES as string[]).includes(role)) {
    return NextResponse.json({ error: "invalid role" }, { status: 400 });
  }

  // Team roles (creative / producer) carry team privileges, so they can
  // only be granted to a VERIFIED team identity (owner allowlist or a
  // verified toolofna.com Google account). A non-team account that asks
  // for creative/producer is silently downgraded to `client` — it may
  // authenticate and comment, but can never self-assign a team role.
  // Clients legitimately pick `client`; that's always allowed.
  let effectiveRole = role as CommentRole;
  if (effectiveRole !== "client") {
    const isTeam = isVerifiedTeamIdentity(session.user.email, {
      isVerifiedTeam: sessionIsVerifiedTeam(session),
    });
    if (!isTeam) {
      effectiveRole = "client";
    }
  }

  const user = await getStore().setUser(
    deckId,
    session.user.email,
    effectiveRole,
    session.user.name ?? undefined
  );

  return NextResponse.json({ user });
}

// ─── Users — for @mention typeahead ────────────────────────────────────

export async function usersGET(req: NextRequest) {
  const url = new URL(req.url);
  const deckId = url.searchParams.get("deckId");
  if (!isValidDeckId(deckId)) {
    return NextResponse.json({ error: "invalid deckId" }, { status: 400 });
  }
  const users = await getStore().listUsers(deckId);
  return NextResponse.json({ users });
}

// ─── Slide reorder overlay ────────────────────────────────────────────
//
// Producers can reorder the deck's slide sequence without writing to
// source. The overlay is stored as an ordered array of slide ids in
// KV; the host applies it via `applyReorder()`. Creative bakes the
// overlay back into source manually (or via Claude) when ready.

export async function reorderGET(req: NextRequest) {
  const url = new URL(req.url);
  const deckId = url.searchParams.get("deckId");
  if (!isValidDeckId(deckId)) {
    return NextResponse.json({ error: "invalid deckId" }, { status: 400 });
  }
  const order = await getStore().getReorder(deckId);
  return NextResponse.json({ order });
}

export async function reorderPATCH(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "auth required" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  const { deckId, order } = body as { deckId?: string; order?: unknown };
  if (!isValidDeckId(deckId)) {
    return NextResponse.json({ error: "invalid deckId" }, { status: 400 });
  }
  if (!Array.isArray(order) || !order.every((id) => typeof id === "string")) {
    return NextResponse.json(
      { error: "order must be an array of slide ids" },
      { status: 400 }
    );
  }

  // Defensive: dedupe ids in the incoming order. Two entries for the
  // same slide should never happen via the UI, but if they do we want
  // a single canonical position rather than ambiguous data on disk.
  const seen = new Set<string>();
  const deduped = order.filter((id) => {
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  // Producer-capable write — gate on a VERIFIED team identity, not a
  // self-declared producer/creative role (an outside Google account
  // must not be able to reorder a client's deck).
  const userRecord = await getStore().getUser(deckId, session.user.email);
  if (
    !canReorderSlides(session.user.email, userRecord?.role, {
      isVerifiedTeam: sessionIsVerifiedTeam(session),
    })
  ) {
    return NextResponse.json({ error: "not authorized" }, { status: 403 });
  }

  await getStore().setReorder(deckId, deduped);
  return NextResponse.json({ ok: true });
}

export async function reorderDELETE(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "auth required" }, { status: 401 });
  }

  const url = new URL(req.url);
  const deckId = url.searchParams.get("deckId");
  if (!isValidDeckId(deckId)) {
    return NextResponse.json({ error: "invalid deckId" }, { status: 400 });
  }

  const userRecord = await getStore().getUser(deckId, session.user.email);
  if (
    !canReorderSlides(session.user.email, userRecord?.role, {
      isVerifiedTeam: sessionIsVerifiedTeam(session),
    })
  ) {
    return NextResponse.json({ error: "not authorized" }, { status: 403 });
  }

  await getStore().clearReorder(deckId);
  return NextResponse.json({ ok: true });
}

// ─── Deck accent overlay ──────────────────────────────────────────────
//
// Creative-only "deck accent color" picker. The overlay is a single
// color string in KV; the host retints the deck via `--deck-accent` in
// staging instantly and bakes the chosen accent into `meta.accent` of
// the production snapshot on PUSH. Same persistence model as the
// reorder overlay — live in staging, frozen into the snapshot on PUSH.
//
// Reads are public (the host needs the staging overlay at render time
// and the client hook fetches it on mount). Writes are creative-only —
// gated identically to publishing (canCurate), since accent is a
// deck-wide creative decision, not a producer-friendly capability.

export async function accentGET(req: NextRequest) {
  const url = new URL(req.url);
  const deckId = url.searchParams.get("deckId");
  if (!isValidDeckId(deckId)) {
    return NextResponse.json({ error: "invalid deckId" }, { status: 400 });
  }
  const accent = await getStore().getAccent(deckId);
  return NextResponse.json({ accent });
}

export async function accentPATCH(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "auth required" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  const { deckId, accent } = body as { deckId?: string; accent?: unknown };
  if (!isValidDeckId(deckId)) {
    return NextResponse.json({ error: "invalid deckId" }, { status: 400 });
  }
  if (typeof accent !== "string" || !accent.trim()) {
    return NextResponse.json(
      { error: "accent must be a color string" },
      { status: 400 }
    );
  }

  const userRecord = await getStore().getUser(deckId, session.user.email);
  if (
    !canCurate(session.user.email, userRecord?.role, {
      isVerifiedTeam: sessionIsVerifiedTeam(session),
    })
  ) {
    return NextResponse.json({ error: "not authorized" }, { status: 403 });
  }

  await getStore().setAccent(deckId, accent.trim());
  return NextResponse.json({ ok: true });
}

export async function accentDELETE(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "auth required" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  const { deckId } = body as { deckId?: string };
  if (!isValidDeckId(deckId)) {
    return NextResponse.json({ error: "invalid deckId" }, { status: 400 });
  }

  const userRecord = await getStore().getUser(deckId, session.user.email);
  if (
    !canCurate(session.user.email, userRecord?.role, {
      isVerifiedTeam: sessionIsVerifiedTeam(session),
    })
  ) {
    return NextResponse.json({ error: "not authorized" }, { status: 403 });
  }

  await getStore().clearAccent(deckId);
  return NextResponse.json({ ok: true });
}

// ─── Case-study overlay ───────────────────────────────────────────────
//
// The host's case-study picker browses an external work archive and
// attaches chosen projects as slides at the end of the deck. The chosen
// list lives in KV as an opaque JSON array — chrome doesn't interpret
// the shape (same as the published snapshot); the host owns the
// case-study schema and materializes each entry into a real slide at
// render time, and bakes the run into the production snapshot on PUSH.
//
// Reads are public (the host needs the staging overlay at render time
// and the picker fetches it on mount). Writes require creative OR
// producer role — gated identically to the reorder overlay
// (canReorderSlides), since attaching past work to the narrative is a
// producer-friendly editorial capability, not a creative-only one.

export async function caseStudiesGET(req: NextRequest) {
  const url = new URL(req.url);
  const deckId = url.searchParams.get("deckId");
  if (!isValidDeckId(deckId)) {
    return NextResponse.json({ error: "invalid deckId" }, { status: 400 });
  }
  const caseStudies = await getStore().getCaseStudies(deckId);
  return NextResponse.json({ caseStudies });
}

export async function caseStudiesPATCH(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "auth required" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  const { deckId, caseStudies } = body as {
    deckId?: string;
    caseStudies?: unknown;
  };
  if (!isValidDeckId(deckId)) {
    return NextResponse.json({ error: "invalid deckId" }, { status: 400 });
  }
  if (!Array.isArray(caseStudies)) {
    return NextResponse.json(
      { error: "caseStudies must be an array" },
      { status: 400 }
    );
  }

  // Producer-capable write that materializes into real client-facing
  // slides — gate on a VERIFIED team identity, not a self-declared
  // producer role, so an outside account can't inject unsourced content.
  const userRecord = await getStore().getUser(deckId, session.user.email);
  if (
    !canReorderSlides(session.user.email, userRecord?.role, {
      isVerifiedTeam: sessionIsVerifiedTeam(session),
    })
  ) {
    return NextResponse.json({ error: "not authorized" }, { status: 403 });
  }

  await getStore().setCaseStudies(deckId, caseStudies);
  return NextResponse.json({ ok: true });
}

// ─── Publish — deck-level snapshot gate for the production view ──────
//
// `GET` is public — both staging and production read the snapshot to
// render the live header ("last published 2h ago") and to source the
// production deck content respectively.
//
// `POST` is creative-only (reuses canCurate's permission
// gate — the same allowlist that controls slide-status writes). Body
// is `{ deckId, content }` where `content` is an opaque DeckContent
// blob. The chrome doesn't validate the shape — the host owns the
// schema and casts back when reading.

export async function publishGET(req: NextRequest) {
  const deckId = new URL(req.url).searchParams.get("deckId");
  if (!isValidDeckId(deckId)) {
    return NextResponse.json({ error: "invalid deckId" }, { status: 400 });
  }
  const published = await getStore().getPublishedContent(deckId);
  return NextResponse.json({ published });
}

export async function publishPOST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "auth required" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  const { deckId, content } = body as {
    deckId?: string;
    content?: unknown;
  };

  if (!isValidDeckId(deckId)) {
    return NextResponse.json({ error: "invalid deckId" }, { status: 400 });
  }
  if (content == null) {
    return NextResponse.json({ error: "content required" }, { status: 400 });
  }

  // Same gate as slide-status writes: a verified team identity acting as
  // creative, or an email in NEXT_PUBLIC_DECK_OWNER_EMAILS. Publishing is
  // a deck-wide action with a big blast radius (it ships to clients), so
  // a self-declared creative on an outside account can never reach it.
  const userRecord = await getStore().getUser(deckId, session.user.email);
  if (
    !canCurate(session.user.email, userRecord?.role, {
      isVerifiedTeam: sessionIsVerifiedTeam(session),
    })
  ) {
    return NextResponse.json({ error: "not authorized" }, { status: 403 });
  }

  const published = await getStore().setPublishedContent(
    deckId,
    content,
    session.user.email
  );
  return NextResponse.json({ published });
}

// ─── Queue — comments triaged for the next "send to Claude" pass ─────
//
// GET is creative-only (the queue exists for the curator; producers
// and clients have no reason to list it). Returns the queued comments
// in chronological order — useful both for the panel's "N selected"
// indicator and for compiling the prompt.
//
// Toggling individual comments in/out of the queue happens via the
// main PATCH handler with a `queued: boolean` field; no separate
// mutation endpoint is needed.

export async function queueGET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "auth required" }, { status: 401 });
  }

  const deckId = new URL(req.url).searchParams.get("deckId");
  if (!isValidDeckId(deckId)) {
    return NextResponse.json({ error: "invalid deckId" }, { status: 400 });
  }

  const userRecord = await getStore().getUser(deckId, session.user.email);
  if (
    !canCurate(session.user.email, userRecord?.role, {
      isVerifiedTeam: sessionIsVerifiedTeam(session),
    })
  ) {
    return NextResponse.json({ error: "not authorized" }, { status: 403 });
  }

  const queued = await getStore().listQueued(deckId);
  return NextResponse.json({ queued });
}

// DELETE empties the whole queue in one shot — the QueueBar's "Clear"
// action, for when the curator changes their mind about a batch before
// sending. Same creative-only gate as the GET; comments themselves are
// untouched (only their `queued` flag is cleared).
export async function queueDELETE(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "auth required" }, { status: 401 });
  }

  const deckId = new URL(req.url).searchParams.get("deckId");
  if (!isValidDeckId(deckId)) {
    return NextResponse.json({ error: "invalid deckId" }, { status: 400 });
  }

  const userRecord = await getStore().getUser(deckId, session.user.email);
  if (
    !canCurate(session.user.email, userRecord?.role, {
      isVerifiedTeam: sessionIsVerifiedTeam(session),
    })
  ) {
    return NextResponse.json({ error: "not authorized" }, { status: 403 });
  }

  await getStore().clearQueue(deckId);
  return NextResponse.json({ ok: true });
}
