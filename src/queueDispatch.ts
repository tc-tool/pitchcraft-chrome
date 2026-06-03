import { NextRequest, NextResponse } from "next/server";
import { auth } from "./authConfig";
import { canCurate } from "./permissions";
import { getStore } from "./store";
import { createClaudeIssue, readDispatchConfig } from "./createClaudeIssue";

/**
 * Server route for the QueueBar "Send via GitHub" button.
 *
 * Reads the curator's currently-queued comments, compiles them into a
 * prompt, then creates a labeled GitHub issue. A workflow in the deck
 * repo (.github/workflows/claude-triage.yml) listens for that label,
 * fires the Anthropic Claude Code action, and opens a pull request
 * implementing the feedback.
 *
 * Why GitHub-issue-as-dispatch (not workflow_dispatch directly):
 * issues persist as a discoverable record — title shows what was
 * requested, body shows the prompt, link shows the resulting PR.
 * workflow_dispatch runs are buried in the Actions tab and harder
 * to find later.
 *
 * Required env:
 *   GITHUB_DISPATCH_TOKEN  — PAT (or GitHub App token) with
 *                            issues:write on the target repo. Stored
 *                            on the deck's Railway service.
 *   PITCHCRAFT_GH_REPO     — "owner/name" of the deck repo (e.g.
 *                            "tc-tool/pitchcraft"). The factory sets
 *                            this when spinning up each deck.
 *
 * Body shape:
 *   { deckId: string, deckTitle?: string, prompt: string }
 */
export async function queueDispatchPOST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "auth required" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  const { deckId, deckTitle, prompt } = body as {
    deckId?: string;
    deckTitle?: string;
    prompt?: string;
  };

  if (!deckId || !prompt?.trim()) {
    return NextResponse.json(
      { error: "deckId and prompt required" },
      { status: 400 }
    );
  }

  // Same gate as queue toggle + publish — creative role + (optional)
  // email allowlist. Producers and clients shouldn't be able to spawn
  // PRs against the deck.
  const userRecord = await getStore().getUser(deckId, session.user.email);
  if (!canCurate(session.user.email, userRecord?.role)) {
    return NextResponse.json({ error: "not authorized" }, { status: 403 });
  }

  const cfg = readDispatchConfig();
  if (!cfg.ok) {
    return NextResponse.json({ error: cfg.error }, { status: 500 });
  }

  // Count comments in the prompt for a friendlier issue title.
  // The compiled prompt format starts each comment with a `> **Name**`
  // line — count those to get the comment count without re-fetching.
  const commentLines = prompt.match(/^> \*\*[^*]+\*\*/gm) ?? [];
  const count = commentLines.length;
  const friendlyTitle = deckTitle ?? deckId;

  try {
    const result = await createClaudeIssue({
      repo: cfg.repo,
      token: cfg.token,
      title: `Triage queue: ${count} comment${count === 1 ? "" : "s"} on ${friendlyTitle}`,
      body: prompt,
    });

    if (!result.ok) {
      return NextResponse.json(
        { error: result.error },
        { status: result.status ?? 502 }
      );
    }

    // Stamp every queued comment with the issue link so each thread shows
    // "Sent to Claude · #N" — the loop is visible on the comment instead
    // of a guess. Best-effort: a stamping hiccup must not fail a dispatch
    // whose issue was already created.
    try {
      const queued = await getStore().listQueued(deckId);
      const dispatchedAt = new Date().toISOString();
      await Promise.all(
        queued.map((c) =>
          getStore().setResolution(deckId, c.id, {
            issueNumber: result.issueNumber,
            issueUrl: result.issueUrl,
            dispatchedAt,
          })
        )
      );
    } catch {
      /* stamping is best-effort */
    }

    return NextResponse.json({
      ok: true,
      issueNumber: result.issueNumber,
      issueUrl: result.issueUrl,
    });
  } catch (e) {
    return NextResponse.json(
      {
        error: "dispatch failed",
        message: e instanceof Error ? e.message : String(e),
      },
      { status: 500 }
    );
  }
}
