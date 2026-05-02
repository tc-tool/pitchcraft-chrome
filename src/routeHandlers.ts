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
  // commenting still works.
  if (
    mentions.length > 0 &&
    process.env.SLACK_BOT_TOKEN &&
    process.env.SLACK_CHANNEL
  ) {
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
