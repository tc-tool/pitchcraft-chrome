"use client";

import { Fragment, type ReactNode } from "react";
import { tintForAuthor } from "./authorColor";
import type { UserRecord } from "./types";

/**
 * Convert a stored comment body into rendered React nodes.
 *
 * Bodies hold mentions inline as `<@email>` tokens (Slack-style).
 * At render time we split the body around those tokens and replace
 * each token with a styled chip showing the mentioned user's display
 * name in their author-color tint.
 *
 * If the mentioned email isn't in the current user lookup (e.g., the
 * user signed out and got cleaned up), we still render the chip with
 * the email as a fallback display — the mention doesn't disappear.
 */
const MENTION_RE = /<@([^>\s]+)>/g;

export function renderBody(
  body: string,
  byEmail: Map<string, UserRecord>
): ReactNode[] {
  const out: ReactNode[] = [];
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  let key = 0;

  // exec is stateful — reset before each pass.
  MENTION_RE.lastIndex = 0;

  while ((m = MENTION_RE.exec(body)) !== null) {
    if (m.index > lastIdx) {
      out.push(
        <Fragment key={key++}>{body.slice(lastIdx, m.index)}</Fragment>
      );
    }
    const email = m[1].toLowerCase();
    const user = byEmail.get(email);
    out.push(<MentionChip key={key++} email={email} user={user} />);
    lastIdx = m.index + m[0].length;
  }

  if (lastIdx < body.length) {
    out.push(<Fragment key={key++}>{body.slice(lastIdx)}</Fragment>);
  }

  return out;
}

function MentionChip({
  email,
  user,
}: {
  email: string;
  user?: UserRecord;
}) {
  const display = user?.name
    ? formatFirstNameLastInitial(user.name)
    : email;

  return (
    <span
      className="inline-flex items-center rounded-full px-1.5 py-0.5 text-[14px] font-medium leading-none text-[#111]"
      style={{ backgroundColor: tintForAuthor(email, 0.3) }}
    >
      @{display}
    </span>
  );
}

function formatFirstNameLastInitial(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return name;
  return `${parts[0]} ${parts[parts.length - 1].charAt(0).toUpperCase()}.`;
}
