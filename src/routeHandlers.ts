import { NextRequest, NextResponse } from "next/server";
import { auth } from "./authConfig";
import { notifySlackMention } from "./notifySlack";
import { canEditSlideStatus, canReorderSlides } from "./permissions";
import { getStore, type SlideStatusValue } from "./store";
import type { Comment, CommentRole, CommentStatus } from "./types";

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

// ─── Comments collection ───────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const deckId = url.searchParams.get("deckId");
  const slideId = url.searchParams.get("slideId") ?? undefined;

  if (!deckId) {
    return NextResponse.json({ error: "deckId required" }, { status: 400 });
  }

  const comments = await getStore().list(deckId, slideId);
  return NextResponse.json({ comments });
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
  } = body as {
    deckId?: string;
    slideId?: string;
    body?: string;
    parentId?: string | null;
    pin?: { x?: number; y?: number } | null;
  };

  if (!deckId || !slideId || !commentBody?.trim()) {
    return NextResponse.json(
      { error: "deckId, slideId, body required" },
      { status: 400 }
    );
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

  // Look up the user's stored role. If they haven't picked yet, reject —
  // the client should have shown the role picker first.
  const userRecord = await getStore().getUser(deckId, session.user.email);
  if (!userRecord) {
    return NextResponse.json(
      { error: "role not set", code: "no_role" },
      { status: 409 }
    );
  }

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
    createdAt: new Date().toISOString(),
    ...(mentions.length > 0 ? { mentions } : {}),
    ...(validatedPin ? { pin: validatedPin } : {}),
  };

  await getStore().create(comment);

  // Slack notification for @mentions — fire-and-forget. Don't block the
  // response on this; if Slack is down or the bot isn't configured,
  // commenting still works. We gate ONLY on the bot token (SLACK_CHANNEL
  // is optional — when unset, notifySlackMention runs in DM mode and
  // pings each mentioned user directly. Requiring SLACK_CHANNEL here
  // would silently disable DM mode entirely).
  //
  // We ALSO synchronously perform an email→Slack-ID lookup just for
  // diagnostic purposes and return the result on the response as
  // `_slackDebug`. This is temporary — the moment DMs are landing
  // reliably we can strip it. The point is to surface lookup failures
  // (missing scope, wrong email, revoked token) somewhere a user can
  // see them without spelunking through deploy logs.
  let slackDebug: unknown = undefined;

  if (mentions.length > 0 && process.env.SLACK_BOT_TOKEN) {
    console.log(
      `[notifySlack] firing for ${mentions.length} mention(s) on comment ${comment.id} (mode=${process.env.SLACK_CHANNEL?.trim() ? "channel" : "dm"})`
    );

    // Synchronous lookup for the response diagnostic. Cheap (single
    // Slack API call per mention, 5s timeout) and isolated from the
    // fire-and-forget post.
    try {
      const token = process.env.SLACK_BOT_TOKEN;
      const lookups = await Promise.all(
        mentions.map(async (email) => {
          try {
            const r = await fetch(
              `https://slack.com/api/users.lookupByEmail?email=${encodeURIComponent(email)}`,
              {
                headers: { Authorization: `Bearer ${token}` },
                signal: AbortSignal.timeout(5000),
              }
            );
            const data = (await r.json()) as {
              ok?: boolean;
              user?: { id?: string };
              error?: string;
            };
            return {
              email,
              ok: !!data.ok,
              userId: data.user?.id,
              error: data.error,
            };
          } catch (e) {
            return {
              email,
              ok: false,
              error: e instanceof Error ? e.message : String(e),
            };
          }
        })
      );
      slackDebug = {
        mode: process.env.SLACK_CHANNEL?.trim() ? "channel" : "dm",
        tokenPresent: true,
        lookups,
      };
    } catch (e) {
      slackDebug = {
        mode: "unknown",
        tokenPresent: true,
        error: e instanceof Error ? e.message : String(e),
      };
    }

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

        const proto =
          req.headers.get("x-forwarded-proto") ??
          (req.url.startsWith("https") ? "https" : "http");
        const host = req.headers.get("host") ?? "localhost:3000";
        const deckUrl = `${proto}://${host}/`;

        await notifySlackMention({
          comment,
          // Chrome stays neutral on the host's content schema — we use
          // deckId as a stable identifier. Hosts that want a friendlier
          // title in Slack can wrap the route handler and override this.
          deckTitle: deckId,
          deckUrl,
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
    slackDebug = {
      mode: "skipped",
      tokenPresent: false,
      note: "SLACK_BOT_TOKEN env var not set on the server",
    };
  }

  return NextResponse.json(
    slackDebug ? { comment, _slackDebug: slackDebug } : { comment },
    { status: 201 }
  );
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
  } = body as {
    deckId?: string;
    commentId?: string;
    status?: string;
    body?: string;
  };

  if (!deckId || !commentId) {
    return NextResponse.json(
      { error: "deckId and commentId required" },
      { status: 400 }
    );
  }

  // Two PATCH modes: body edit (own comment only) or status change.
  // If a body is supplied we treat the request as an edit; otherwise
  // it's a status update.
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
  if (!deckId) {
    return NextResponse.json({ error: "deckId required" }, { status: 400 });
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

  if (!(VALID_ROLES as string[]).includes(role)) {
    return NextResponse.json({ error: "invalid role" }, { status: 400 });
  }

  const user = await getStore().setUser(
    deckId,
    session.user.email,
    role as CommentRole,
    session.user.name ?? undefined
  );

  return NextResponse.json({ user });
}

// ─── Users — for @mention typeahead ────────────────────────────────────

export async function usersGET(req: NextRequest) {
  const url = new URL(req.url);
  const deckId = url.searchParams.get("deckId");
  if (!deckId) {
    return NextResponse.json({ error: "deckId required" }, { status: 400 });
  }
  const users = await getStore().listUsers(deckId);
  return NextResponse.json({ users });
}

// ─── Slide status overlay — creative-only writes ───────────────────────

const VALID_SLIDE_STATUSES: SlideStatusValue[] = [
  "draft",
  "review",
  "approved",
];

export async function slideStatusGET(req: NextRequest) {
  const url = new URL(req.url);
  const deckId = url.searchParams.get("deckId");
  if (!deckId) {
    return NextResponse.json({ error: "deckId required" }, { status: 400 });
  }
  const statuses = await getStore().getSlideStatuses(deckId);
  return NextResponse.json({ statuses });
}

export async function slideStatusPATCH(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "auth required" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  const { deckId, slideId, status } = body as {
    deckId?: string;
    slideId?: string;
    status?: string;
  };

  if (!deckId || !slideId || !status) {
    return NextResponse.json(
      { error: "deckId, slideId, status required" },
      { status: 400 }
    );
  }
  if (!(VALID_SLIDE_STATUSES as string[]).includes(status)) {
    return NextResponse.json({ error: "invalid status" }, { status: 400 });
  }

  // Permission gate. If NEXT_PUBLIC_DECK_OWNER_EMAILS is set, only those
  // emails can edit. Otherwise fall back to "any creative on this deck".
  const userRecord = await getStore().getUser(deckId, session.user.email);
  if (!canEditSlideStatus(session.user.email, userRecord?.role)) {
    return NextResponse.json(
      { error: "not authorized" },
      { status: 403 }
    );
  }

  await getStore().setSlideStatus(
    deckId,
    slideId,
    status as SlideStatusValue
  );
  return NextResponse.json({ ok: true });
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
  if (!deckId) {
    return NextResponse.json({ error: "deckId required" }, { status: 400 });
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
  if (!deckId) {
    return NextResponse.json({ error: "deckId required" }, { status: 400 });
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

  const userRecord = await getStore().getUser(deckId, session.user.email);
  if (!canReorderSlides(session.user.email, userRecord?.role)) {
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
  if (!deckId) {
    return NextResponse.json({ error: "deckId required" }, { status: 400 });
  }

  const userRecord = await getStore().getUser(deckId, session.user.email);
  if (!canReorderSlides(session.user.email, userRecord?.role)) {
    return NextResponse.json({ error: "not authorized" }, { status: 403 });
  }

  await getStore().clearReorder(deckId);
  return NextResponse.json({ ok: true });
}

// ─── Publish — deck-level snapshot gate for the production view ──────
//
// `GET` is public — both staging and production read the snapshot to
// render the live header ("last published 2h ago") and to source the
// production deck content respectively.
//
// `POST` is creative-only (reuses canEditSlideStatus's permission
// gate — the same allowlist that controls slide-status writes). Body
// is `{ deckId, content }` where `content` is an opaque DeckContent
// blob. The chrome doesn't validate the shape — the host owns the
// schema and casts back when reading.

export async function publishGET(req: NextRequest) {
  const deckId = new URL(req.url).searchParams.get("deckId");
  if (!deckId) {
    return NextResponse.json({ error: "deckId required" }, { status: 400 });
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

  if (!deckId) {
    return NextResponse.json({ error: "deckId required" }, { status: 400 });
  }
  if (content == null) {
    return NextResponse.json({ error: "content required" }, { status: 400 });
  }

  // Same gate as slide-status writes: creative role + (optionally)
  // email in NEXT_PUBLIC_DECK_OWNER_EMAILS. Publishing is a deck-wide
  // action with bigger blast radius than per-slide flips, but the
  // permission model is the same — anyone who can mark a slide
  // approved can publish the deck.
  const userRecord = await getStore().getUser(deckId, session.user.email);
  if (!canEditSlideStatus(session.user.email, userRecord?.role)) {
    return NextResponse.json({ error: "not authorized" }, { status: 403 });
  }

  const published = await getStore().setPublishedContent(
    deckId,
    content,
    session.user.email
  );
  return NextResponse.json({ published });
}
