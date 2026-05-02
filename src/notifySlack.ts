/**
 * Slack notifications for @mentions — real user pings, not just text.
 *
 * Two delivery modes, in priority order:
 *
 *   1. **DM mode (default).** When `SLACK_CHANNEL` is unset, each
 *      mentioned user gets a direct DM from the bot. Works across
 *      every deck without per-deck config — the bot just needs to be
 *      installed in the workspace once. Ideal for studios where each
 *      pitch has different stakeholders and a shared channel doesn't
 *      make sense.
 *
 *   2. **Channel mode.** When `SLACK_CHANNEL` IS set (channel name
 *      `#foo` or channel id `C01ABC...`), the message posts there
 *      instead. Mentions render as real `<@U…>` pings inside the
 *      channel post so the right people still get notified, plus the
 *      whole team can see the activity. Useful for client-specific
 *      channels where stakeholders want a shared log.
 *
 * Either way, mentions are real Slack pings (notification, red dot,
 * mobile push) — we resolve email → Slack member ID via
 * `users.lookupByEmail` and use the `<@U…>` token format.
 *
 * Setup:
 *   - api.slack.com/apps → Create New App → From scratch
 *   - OAuth & Permissions → bot scopes:
 *       chat:write, users:read, users:read.email
 *     (For DM mode, Slack lets bots DM any user that's in a channel
 *     with them or is in the workspace — chat:write is enough.)
 *   - Install to Workspace, copy Bot User OAuth Token (xoxb-...)
 *   - Channel mode only: invite the bot to the channel via
 *     `/invite @<your-bot>`
 *   - .env.local:
 *       SLACK_BOT_TOKEN=xoxb-...
 *       SLACK_CHANNEL=                (blank = DM mode, set = channel)
 *
 * Fire-and-forget. Slack outages don't block comment posting.
 */

import type { Comment } from "./types";

interface SlackMentionInput {
  comment: Comment;
  /** Deck title from deckContent.meta.title — surfaced in the Slack message. */
  deckTitle: string;
  /** Direct URL back to the deck. Used as the "Open in deck" link. */
  deckUrl: string;
  /** Verified emails of mentioned users — server-extracted from the body. */
  mentionedEmails: string[];
  /**
   * Display names for each mention (same order as mentionedEmails).
   * Used as fallback when Slack ID lookup fails.
   */
  mentionedDisplay: string[];
}

const SLACK_API = "https://slack.com/api";

async function lookupSlackUserId(
  email: string,
  botToken: string
): Promise<string | null> {
  try {
    const res = await fetch(
      `${SLACK_API}/users.lookupByEmail?email=${encodeURIComponent(email)}`,
      {
        headers: { Authorization: `Bearer ${botToken}` },
        // 5s timeout via AbortController
        signal: AbortSignal.timeout(5000),
      }
    );
    const data = (await res.json()) as {
      ok?: boolean;
      user?: { id?: string };
      error?: string;
    };
    if (data.ok && data.user?.id) return data.user.id;
    return null;
  } catch {
    return null;
  }
}

async function postSlackMessage(
  channel: string,
  blocks: unknown[],
  fallbackText: string,
  botToken: string
): Promise<void> {
  try {
    const res = await fetch(`${SLACK_API}/chat.postMessage`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${botToken}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({ channel, blocks, text: fallbackText }),
      signal: AbortSignal.timeout(5000),
    });
    const data = (await res.json()) as { ok?: boolean; error?: string };
    if (!data.ok) {
      console.warn(
        `[notifySlack] chat.postMessage to ${channel} failed`,
        data.error
      );
    }
  } catch (e) {
    console.warn(`[notifySlack] post to ${channel} failed`, e);
  }
}

export async function notifySlackMention(
  input: SlackMentionInput
): Promise<void> {
  const botToken = process.env.SLACK_BOT_TOKEN;
  if (!botToken) return; // bot not configured; silently skip

  const explicitChannel = process.env.SLACK_CHANNEL?.trim();

  const {
    comment,
    deckTitle,
    deckUrl,
    mentionedEmails,
    mentionedDisplay,
  } = input;

  // Resolve every email → Slack ID in parallel. Each resolves to either
  // a user id or null; null falls back to the display name. We need
  // these for both modes — channel posts use them as `<@U…>` tokens
  // for real pings, DM mode uses them as the post target.
  const slackIds = await Promise.all(
    mentionedEmails.map((email) => lookupSlackUserId(email, botToken))
  );

  const mentionTokens = mentionedEmails.map((email, i) => {
    const id = slackIds[i];
    if (id) return `<@${id}>`;
    return `*${mentionedDisplay[i] ?? email}*`;
  });

  const mentionLine =
    mentionTokens.length > 0 ? mentionTokens.join(", ") : "*someone*";

  // Strip internal `<@email>` tokens from the body — Slack would render
  // them as literal text and they look ugly.
  const body = comment.body
    .replace(/<@([^>\s]+)>/g, "@$1")
    .slice(0, 500);

  const fallbackText = `${comment.authorName} mentioned ${
    mentionedDisplay.join(", ") || "someone"
  } in ${deckTitle} — ${comment.slideId}`;

  // ─── Channel mode ───────────────────────────────────────────────
  if (explicitChannel) {
    const blocks = [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `${mentionLine} mentioned in *${deckTitle}* — slide \`${comment.slideId}\``,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `> ${body.replace(/\n/g, "\n> ")}`,
        },
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `by *${comment.authorName}* (${comment.role}) · <${deckUrl}|Open in deck →>`,
          },
        ],
      },
    ];
    await postSlackMessage(explicitChannel, blocks, fallbackText, botToken);
    return;
  }

  // ─── DM mode (default) ──────────────────────────────────────────
  // DM each user whose email resolved to a Slack ID. Users we couldn't
  // resolve get silently dropped — no fallback channel to post to.
  // Each DM is phrased "you were mentioned" since the recipient already
  // knows it's about them (the DM is implicit attribution).
  const recipients = slackIds.filter(
    (id): id is string => typeof id === "string"
  );
  if (recipients.length === 0) return;

  const dmBlocks = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `You were mentioned in *${deckTitle}* — slide \`${comment.slideId}\``,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `> ${body.replace(/\n/g, "\n> ")}`,
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `by *${comment.authorName}* (${comment.role}) · <${deckUrl}|Open in deck →>`,
        },
      ],
    },
  ];

  await Promise.all(
    recipients.map((id) =>
      postSlackMessage(id, dmBlocks, fallbackText, botToken)
    )
  );
}
