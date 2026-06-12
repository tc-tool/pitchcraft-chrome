/**
 * Shared helper for creating a labeled GitHub issue that triggers the
 * deck repo's `claude-triage.yml` workflow. Used by every Pitchcraft
 * surface that needs Claude to make a code change against the deck
 * source — comment-queue dispatch, slide add/delete dispatch, and any
 * future "ask Claude to do X to deck.content.ts" flow.
 *
 * Why one helper: every dispatch ultimately becomes a labeled GitHub
 * issue with a prompt in the body. The variation is only in title +
 * prompt. Centralizing the API call keeps label management, auth
 * headers, and error shapes in one place; new dispatches just compose
 * a prompt and call this.
 */

export interface CreateClaudeIssueOpts {
  /** `owner/name` of the deck repo, e.g. `tooldigital/pitchcraft`. */
  repo: string;
  /** PAT or GitHub App token with `issues:write` on `repo`. */
  token: string;
  /** Issue title — shown in GitHub UI + email notifications. */
  title: string;
  /** Issue body — becomes the prompt the Claude Code action runs. */
  body: string;
}

export interface CreateClaudeIssueResult {
  ok: boolean;
  issueNumber?: number;
  issueUrl?: string;
  error?: string;
  /** HTTP status from GitHub if the request reached the API but failed. */
  status?: number;
}

const LABEL_NAME = "claude-triage";
const LABEL_COLOR = "0e8a16";
const LABEL_DESCRIPTION = "Triggers the claude-triage workflow";

export async function createClaudeIssue(
  opts: CreateClaudeIssueOpts
): Promise<CreateClaudeIssueResult> {
  const { repo, token, title, body } = opts;

  // (1) Idempotently ensure the `claude-triage` label exists. GitHub
  // returns 422 if it's already there — we don't care which way it
  // goes, only that the label exists by the time we create the issue.
  // Errors here are silently absorbed; the issue creation will fail
  // loudly if the label genuinely can't be applied.
  try {
    await fetch(`https://api.github.com/repos/${repo}/labels`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: LABEL_NAME,
        color: LABEL_COLOR,
        description: LABEL_DESCRIPTION,
      }),
    });
  } catch {
    /* swallow — label creation is best-effort */
  }

  // (2) Create the issue with the label applied. The label is what
  // triggers the workflow; the body is what becomes the prompt.
  try {
    const res = await fetch(
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
          title,
          body,
          labels: [LABEL_NAME],
        }),
      }
    );

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return {
        ok: false,
        status: res.status,
        error: `GitHub issue creation failed (${res.status}): ${text.slice(0, 200)}`,
      };
    }

    const issue = (await res.json()) as {
      number?: number;
      html_url?: string;
    };
    return {
      ok: true,
      issueNumber: issue.number,
      issueUrl: issue.html_url,
    };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * Read the GitHub dispatch config from env, raising a descriptive error
 * if either piece is missing. Pulled out so dispatch route handlers
 * don't repeat the same two checks.
 */
export function readDispatchConfig():
  | { ok: true; token: string; repo: string }
  | { ok: false; error: string } {
  const token = process.env.GITHUB_DISPATCH_TOKEN;
  const repo = process.env.PITCHCRAFT_GH_REPO;
  if (!token) {
    return {
      ok: false,
      error: "GITHUB_DISPATCH_TOKEN not set on the server",
    };
  }
  if (!repo || !/^[^/]+\/[^/]+$/.test(repo)) {
    return {
      ok: false,
      error: "PITCHCRAFT_GH_REPO must be set as owner/name",
    };
  }
  return { ok: true, token, repo };
}
