import { NextRequest, NextResponse } from "next/server";
import { auth } from "./authConfig";
import { canCurate } from "./permissions";
import { getStore } from "./store";

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

  const token = process.env.GITHUB_DISPATCH_TOKEN;
  const repo = process.env.PITCHCRAFT_GH_REPO;
  if (!token) {
    return NextResponse.json(
      { error: "GITHUB_DISPATCH_TOKEN not set on the server" },
      { status: 500 }
    );
  }
  if (!repo || !/^[^/]+\/[^/]+$/.test(repo)) {
    return NextResponse.json(
      { error: "PITCHCRAFT_GH_REPO must be set as owner/name" },
      { status: 500 }
    );
  }

  // Count comments in the prompt for a friendlier issue title.
  // The compiled prompt format starts each comment with a `> **Name**`
  // line — count those to get the comment count without re-fetching.
  const commentLines = prompt.match(/^> \*\*[^*]+\*\*/gm) ?? [];
  const count = commentLines.length;
  const friendlyTitle = deckTitle ?? deckId;

  try {
    // First: ensure the `claude-triage` label exists on the repo.
    // POST creates it; 422 means it already exists (idempotent).
    await fetch(`https://api.github.com/repos/${repo}/labels`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({
        name: "claude-triage",
        color: "0e8a16",
        description: "Triggers the claude-triage workflow",
      }),
    });

    // Create the issue. Label triggers the workflow; the body IS the
    // prompt that gets passed to the Claude Code action.
    const issueRes = await fetch(
      `https://api.github.com/repos/${repo}/issues`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          title: `Triage queue: ${count} comment${count === 1 ? "" : "s"} on ${friendlyTitle}`,
          body: prompt,
          labels: ["claude-triage"],
        }),
      }
    );

    if (!issueRes.ok) {
      const errBody = await issueRes.text().catch(() => "");
      return NextResponse.json(
        {
          error: "GitHub issue creation failed",
          status: issueRes.status,
          details: errBody.slice(0, 500),
        },
        { status: 502 }
      );
    }

    const issue = (await issueRes.json()) as {
      number?: number;
      html_url?: string;
    };

    return NextResponse.json({
      ok: true,
      issueNumber: issue.number,
      issueUrl: issue.html_url,
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
