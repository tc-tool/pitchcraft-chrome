import { NextRequest, NextResponse } from "next/server";
import { auth } from "./authConfig";
import { canCurate } from "./permissions";
import { getStore } from "./store";
import { createClaudeIssue, readDispatchConfig } from "./createClaudeIssue";

/**
 * Slide-source mutations — add and delete slides in the host deck's
 * `content/deck.content.ts`.
 *
 * Why this is dispatch-based (not a direct file write):
 *   - `deck.content.ts` is bundled into the Next.js server at build
 *     time. Writing to disk on a running Railway container doesn't
 *     reload the bundle — the slide still renders from in-memory state.
 *   - Railway container filesystems are ephemeral. Even if the bundle
 *     re-evaluated, the file change vanishes on the next deploy or
 *     restart, when git re-checkouts the source.
 *   - Per the constitution, structural changes to `deck.content.ts`
 *     are source changes — they go through the creative + Claude path
 *     like any other source change.
 *
 * Both POST (add) and DELETE (remove) compile a prompt, create a
 * labeled GitHub issue, and let the claude-triage workflow run Claude
 * with that prompt. Claude opens a PR; the creative reviews + merges;
 * Railway redeploys. Same loop as the comment-queue dispatch — one
 * shared mechanism for "ask Claude to change deck source."
 */

interface SlideDispatchBody {
  deckId?: string;
  /** Add only — id of the slide the new one should follow, or null for top. */
  afterId?: string | null;
  /** Delete only — id of the slide to remove. */
  slideId?: string;
}

/**
 * POST — request that Claude add a new placeholder slide.
 *
 * Body: `{ deckId, afterId }`. `afterId` is null to insert at the top
 * of the deck, or a slide id to insert after that specific slide.
 */
export async function slideAddDispatchPOST(req: NextRequest) {
  const ctx = await guardDispatch(req);
  if ("error" in ctx) return ctx.error;

  const { deckId, afterId = null } = ctx.body;
  if (!deckId) {
    return NextResponse.json({ error: "deckId required" }, { status: 400 });
  }

  const prompt = composeAddSlidePrompt({ deckId, afterId });

  const result = await createClaudeIssue({
    repo: ctx.repo,
    token: ctx.token,
    title: `Add slide after ${afterId ?? "(top of deck)"}`,
    body: prompt,
  });

  if (!result.ok) {
    return NextResponse.json(
      { error: result.error },
      { status: result.status ?? 502 }
    );
  }

  return NextResponse.json({
    ok: true,
    issueNumber: result.issueNumber,
    issueUrl: result.issueUrl,
  });
}

/**
 * DELETE — request that Claude remove a slide.
 *
 * Body: `{ deckId, slideId }`. Slide id refers to the `id` field of
 * the slide object literal in `slides[]`.
 *
 * Two things happen on this call, in order:
 *
 * 1. The slide id is added to the `deletedSlides` overlay in Redis.
 *    `renderDeckPage` reads that overlay in staging mode and filters
 *    the slide out — so the curator sees it vanish immediately on
 *    the next request (a client-side router.refresh() takes care of
 *    that).
 *
 * 2. A Claude PR is dispatched to bring deck.content.ts source in
 *    line with the overlay. The source change merges in the
 *    background. Once it lands and Railway redeploys, the overlay
 *    becomes redundant (the slide is gone from source too) and can
 *    be cleared at any time — keeping an orphan id in the set is
 *    harmless either way.
 *
 * If the PR creation fails (no token, GitHub down, etc.) we still
 * keep the overlay marking. Source convergence has to happen
 * manually in that case, but the curator's intent ("this slide
 * shouldn't be visible") is honored immediately.
 */
export async function slideDeleteDispatchDELETE(req: NextRequest) {
  const ctx = await guardDispatch(req);
  if ("error" in ctx) return ctx.error;

  const { deckId, slideId } = ctx.body;
  if (!deckId || !slideId) {
    return NextResponse.json(
      { error: "deckId and slideId required" },
      { status: 400 }
    );
  }

  // (1) Instant hide. This is the part that makes the click feel like
  // a delete to the user; the PR work below is bookkeeping.
  await getStore().markSlideDeleted(deckId, slideId);

  // (2) Source convergence via Claude PR.
  const prompt = composeDeleteSlidePrompt({ deckId, slideId });
  const result = await createClaudeIssue({
    repo: ctx.repo,
    token: ctx.token,
    title: `Delete slide \`${slideId}\``,
    body: prompt,
  });

  // The overlay is already set — even if the PR creation failed, the
  // curator gets the immediate hide. Surface the PR error so they
  // know source isn't catching up automatically and someone needs to
  // make the edit manually (or fix the token).
  return NextResponse.json({
    ok: true,
    slideHiddenImmediately: true,
    issueNumber: result.ok ? result.issueNumber : undefined,
    issueUrl: result.ok ? result.issueUrl : undefined,
    prError: result.ok ? undefined : result.error,
  });
}

// ─── Shared guard ──────────────────────────────────────────────────────

/**
 * Validate auth + curator permission + dispatch config in one place so
 * both handlers stay short. Returns the validated context (body + dispatch
 * config) on success, or a NextResponse to return immediately on failure.
 */
async function guardDispatch(
  req: NextRequest
): Promise<
  | { error: NextResponse }
  | { body: SlideDispatchBody; repo: string; token: string }
> {
  const session = await auth();
  if (!session?.user?.email) {
    return {
      error: NextResponse.json(
        { error: "auth required" },
        { status: 401 }
      ),
    };
  }

  let body: SlideDispatchBody;
  try {
    // DELETE requests can carry a JSON body in Next.js — supported by
    // fetch + the platform — so we always parse rather than branching
    // on method.
    body = (await req.json()) as SlideDispatchBody;
  } catch {
    return {
      error: NextResponse.json(
        { error: "invalid body" },
        { status: 400 }
      ),
    };
  }

  const deckId = body.deckId;
  if (!deckId) {
    return {
      error: NextResponse.json(
        { error: "deckId required" },
        { status: 400 }
      ),
    };
  }

  const userRecord = await getStore().getUser(deckId, session.user.email);
  if (!canCurate(session.user.email, userRecord?.role)) {
    return {
      error: NextResponse.json(
        { error: "not authorized" },
        { status: 403 }
      ),
    };
  }

  const cfg = readDispatchConfig();
  if (!cfg.ok) {
    return {
      error: NextResponse.json({ error: cfg.error }, { status: 500 }),
    };
  }

  return { body, repo: cfg.repo, token: cfg.token };
}

// ─── Prompt composers ──────────────────────────────────────────────────

function composeAddSlidePrompt(opts: {
  deckId: string;
  afterId: string | null;
}): string {
  const { deckId, afterId } = opts;
  const position = afterId
    ? `directly after the slide whose \`id\` is \`"${afterId}"\``
    : `at the very top of the \`slides\` array (position 0)`;

  return [
    `Add a new placeholder slide to \`content/deck.content.ts\` in the`,
    `deck *${deckId}* (working directory \`~/Desktop/Tyler/toolOS/${deckId}/\`).`,
    ``,
    `**Where to insert:** ${position}.`,
    ``,
    `**What to insert:** a basic Placeholder-type slide. The object`,
    `literal should look like:`,
    ``,
    "```ts",
    `{`,
    `  id: "<generate a fresh kebab-case id — e.g. 'untitled-3', 'placeholder-2x4f'>",`,
    `  type: "placeholder",`,
    `  visibility: "external",`,
    `  eyebrow: "Untitled",`,
    `},`,
    "```",
    ``,
    `Generate the \`id\` so it's unique within the existing \`slides\` array.`,
    `Use lowercase letters, digits, and hyphens — no other characters.`,
    ``,
    `Don't modify any other slide objects. Don't change anything else`,
    `in the file. Don't touch other files.`,
    ``,
    `When done, commit and open a PR titled "Add placeholder slide".`,
  ].join("\n");
}

function composeDeleteSlidePrompt(opts: {
  deckId: string;
  slideId: string;
}): string {
  const { deckId, slideId } = opts;

  return [
    `Delete the slide whose \`id\` is \`"${slideId}"\` from`,
    `\`content/deck.content.ts\` in the deck *${deckId}* (working`,
    `directory \`~/Desktop/Tyler/toolOS/${deckId}/\`).`,
    ``,
    `**Steps:**`,
    `1. Open \`content/deck.content.ts\`.`,
    `2. Locate the object literal in the \`slides\` array whose \`id\``,
    `   is exactly \`"${slideId}"\`.`,
    `3. Remove that entire object literal (and the trailing comma if`,
    `   it has one) so the \`slides\` array no longer contains it.`,
    `4. Save the file.`,
    ``,
    `**Do not** modify any other slide. **Do not** touch other files`,
    `unless the deletion strictly requires it (e.g. an unused import`,
    `that's now unreferenced — leaving it is also fine).`,
    ``,
    `If the slide id isn't found in the file, stop and report that`,
    `rather than guessing.`,
    ``,
    `When done, commit and open a PR titled "Delete slide \`${slideId}\`".`,
  ].join("\n");
}
