import { NextRequest, NextResponse } from "next/server";
import { auth } from "./authConfig";
import { canCurate } from "./permissions";
import { getStore } from "./store";

/**
 * Slide structural operations — add and delete slides.
 *
 * These are *live database state*, not source changes. A delete records
 * the slide id in the `deletedSlides` overlay; an add records a
 * placeholder in the `addedSlides` overlay. Both take effect instantly:
 *
 *   - `renderDeckPage` applies both overlays in staging, so the curator
 *     sees the change the moment they click (after a router.refresh()).
 *   - PUSH bakes both overlays into the production snapshot, so what you
 *     see in staging is exactly what ships.
 *
 * There is deliberately NO GitHub issue, no Claude PR, no merge step.
 * `deck.content.ts` is reconciled with these overlays later, as a
 * deliberate authoring act through Claude Code — never as a tax on a
 * single click. This is the whole point: the editing loop is immediate
 * and intuitive; the source file is a developer concern that never
 * surfaces to a producer or creative mid-review.
 *
 * (Real content/copy/design changes — "make this headline bigger" — are
 * a different thing. Those still go through the comment → Claude → PR
 * loop, because they're genuine code. Structural add/delete/reorder do
 * not.)
 */

interface SlideMutationBody {
  deckId?: string;
  /** Add only — id of the slide the new one should follow, or null for top. */
  afterId?: string | null;
  /** Delete only — id of the slide to remove. */
  slideId?: string;
}

/**
 * POST — add a new placeholder slide. Instant.
 *
 * Body: `{ deckId, afterId }`. `afterId` is null to insert at the top
 * of the deck, or a slide id to insert after that specific slide.
 * Returns the generated slide id so the client can refresh and find it.
 */
export async function slideAddDispatchPOST(req: NextRequest) {
  const ctx = await guardSlideMutation(req);
  if ("error" in ctx) return ctx.error;

  const { deckId, afterId = null } = ctx.body;

  // Generate a unique, URL/id-safe placeholder id. The host materializes
  // an actual placeholder slide object from this id at render time.
  const id = `slide-${crypto.randomUUID().slice(0, 8)}`;
  await getStore().addSlide(deckId, { id, afterId });

  return NextResponse.json({ ok: true, slideId: id });
}

/**
 * DELETE — remove a slide. Instant.
 *
 * Body: `{ deckId, slideId }`. Marks the id deleted (filters it out of
 * staging + bakes it out of the production snapshot on PUSH) and, if the
 * id was an overlay-added placeholder, drops it from the added overlay
 * too. Both writes are idempotent, so a stray double-click is harmless.
 */
export async function slideDeleteDispatchDELETE(req: NextRequest) {
  const ctx = await guardSlideMutation(req);
  if ("error" in ctx) return ctx.error;

  const { deckId, slideId } = ctx.body;
  if (!slideId) {
    return NextResponse.json({ error: "slideId required" }, { status: 400 });
  }

  const store = getStore();
  // Mark deleted (for source slides) AND drop from the added overlay
  // (for placeholders that only ever existed in the overlay). Doing
  // both means "delete" behaves identically no matter where the slide
  // came from.
  await Promise.all([
    store.markSlideDeleted(deckId, slideId),
    store.removeAddedSlide(deckId, slideId),
  ]);

  return NextResponse.json({ ok: true });
}

// ─── Shared guard ──────────────────────────────────────────────────────

/**
 * Validate auth + curator permission + deckId. Returns the validated
 * body on success, or a NextResponse to return immediately on failure.
 *
 * Note: unlike the comment-queue dispatch, these handlers touch nothing
 * external (no GitHub), so there's no dispatch-config requirement — a
 * deck with no GitHub token still gets working add/delete.
 */
async function guardSlideMutation(
  req: NextRequest
): Promise<
  | { error: NextResponse }
  | { body: SlideMutationBody & { deckId: string } }
> {
  const session = await auth();
  if (!session?.user?.email) {
    return {
      error: NextResponse.json({ error: "auth required" }, { status: 401 }),
    };
  }

  let body: SlideMutationBody;
  try {
    body = (await req.json()) as SlideMutationBody;
  } catch {
    return {
      error: NextResponse.json({ error: "invalid body" }, { status: 400 }),
    };
  }

  const deckId = body.deckId;
  if (!deckId) {
    return {
      error: NextResponse.json({ error: "deckId required" }, { status: 400 }),
    };
  }

  const userRecord = await getStore().getUser(deckId, session.user.email);
  if (!canCurate(session.user.email, userRecord?.role)) {
    return {
      error: NextResponse.json({ error: "not authorized" }, { status: 403 }),
    };
  }

  return { body: { ...body, deckId } };
}
