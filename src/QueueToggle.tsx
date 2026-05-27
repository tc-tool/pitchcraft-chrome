"use client";

import { useState } from "react";
import { useCurrentUser } from "./useCurrentUser";
import { canCurate } from "./permissions";
import type { Comment } from "./types";

interface QueueToggleProps {
  comment: Comment;
  /**
   * Called when the user toggles. Caller (the panel) owns the actual
   * mutation via useQueue.toggle; we just surface intent. Optimistic
   * update is the caller's responsibility.
   */
  onToggle: (commentId: string, queued: boolean) => Promise<void> | void;
}

/**
 * Per-comment "queue for Claude" checkbox.
 *
 * Renders nothing if the viewer isn't authorized to curate (so
 * producers/clients never see the affordance, even though chrome
 * mounts the panel for everyone).
 *
 * Visual: a small square checkbox in the chrome palette. Empty when
 * not queued, filled with a check when queued. Sits inline with the
 * other per-comment actions (Edit / Delete / Mark resolved).
 *
 * Why a checkbox vs a star/flag: this is bulk selection, not favoriting.
 * The mental model is Gmail's bulk select — pick the items you want to
 * act on. A square reads as "selectable" more clearly than a star, which
 * reads as "favorite this." Keeps the icon language honest.
 */
export function QueueToggle({ comment, onToggle }: QueueToggleProps) {
  const { user } = useCurrentUser();
  const [pending, setPending] = useState(false);

  if (!user || !canCurate(user.email, user.role)) return null;

  // Replies don't need their own checkbox — the root thread is what
  // Claude implements. Hiding them keeps the panel uncluttered.
  if (comment.parentId) return null;

  const queued = !!comment.queued;

  const onClick = async () => {
    if (pending) return;
    setPending(true);
    try {
      await onToggle(comment.id, !queued);
    } finally {
      setPending(false);
    }
  };

  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={queued}
      aria-label={queued ? "Remove from queue" : "Add to queue for Claude"}
      title={queued ? "Queued — click to remove" : "Queue for Claude"}
      disabled={pending}
      className={`inline-flex size-[14px] items-center justify-center rounded-[3px] ring-1 transition-[background-color,box-shadow,color] duration-150 ease-out ${
        queued
          ? "bg-[#111] text-white ring-black/[0.10] shadow-[inset_0_1px_0_rgba(255,255,255,0.10)]"
          : "bg-black/[0.04] text-transparent ring-black/[0.12] hover:bg-black/[0.08] hover:ring-black/[0.20]"
      } disabled:opacity-50 disabled:cursor-wait`}
    >
      <CheckIcon />
    </button>
  );
}

function CheckIcon() {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M2 5.2 L4 7.2 L8 2.8" />
    </svg>
  );
}
