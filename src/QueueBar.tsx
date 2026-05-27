"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useQueue } from "./useQueue";
import { useCurrentUser } from "./useCurrentUser";
import { useDeckId } from "./CommentsProvider";
import { canCurate } from "./permissions";
import { CHROME_DURATION, CHROME_EASE } from "./motion";

interface QueueBarProps {
  /**
   * Friendly deck title for the prompt header — e.g. "Rings of Power S3".
   * Optional; falls back to the deckId slug.
   */
  deckTitle?: string;
}

/**
 * Sticky bar that appears at the bottom of the comment panel whenever
 * the queue has at least one comment in it. Surfaces the count and
 * exposes the "Send to Claude" handoff.
 *
 * Renders nothing for non-curator viewers — same gate as QueueToggle.
 * Also renders nothing when the queue is empty (no noise when there's
 * nothing to act on).
 */
export function QueueBar({ deckTitle }: QueueBarProps) {
  const { user } = useCurrentUser();
  const { queue, compile } = useQueue();
  const [modalOpen, setModalOpen] = useState(false);

  if (!user || !canCurate(user.email, user.role)) return null;
  if (queue.length === 0) return null;

  return (
    <>
      <motion.div
        className="sticky bottom-0 z-10 -mx-4 mt-3 border-t border-black/[0.06] bg-[rgba(244,249,254,0.94)] px-4 py-2.5 backdrop-blur-xl backdrop-saturate-150"
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 4 }}
        transition={{ duration: CHROME_DURATION, ease: CHROME_EASE }}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="text-[11.5px] tabular-nums text-black/65">
            <span className="font-medium text-[#111]">{queue.length}</span>{" "}
            queued for Claude
          </div>
          <button
            type="button"
            onClick={() => setModalOpen(true)}
            className="rounded-full bg-[#111] px-3.5 py-1.5 text-[11.5px] font-medium text-white transition-colors hover:bg-black"
          >
            Send to Claude →
          </button>
        </div>
      </motion.div>

      <AnimatePresence>
        {modalOpen && (
          <CompilePromptModal
            promptText={compile(deckTitle)}
            count={queue.length}
            deckTitle={deckTitle}
            onClose={() => setModalOpen(false)}
          />
        )}
      </AnimatePresence>
    </>
  );
}

// ─── Compile modal ────────────────────────────────────────────────────

interface CompilePromptModalProps {
  promptText: string;
  count: number;
  deckTitle?: string;
  onClose: () => void;
}

interface DispatchResult {
  ok: boolean;
  issueNumber?: number;
  issueUrl?: string;
  error?: string;
}

function CompilePromptModal({
  promptText,
  count,
  deckTitle,
  onClose,
}: CompilePromptModalProps) {
  const deckId = useDeckId();
  const [copied, setCopied] = useState(false);
  const [dispatching, setDispatching] = useState(false);
  const [dispatchResult, setDispatchResult] =
    useState<DispatchResult | null>(null);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(promptText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2200);
    } catch {
      // Clipboard write can fail in some browsers — leave the textarea
      // visible so the user can manually select + copy.
    }
  };

  const onDispatch = async () => {
    setDispatching(true);
    setDispatchResult(null);
    try {
      const res = await fetch("/api/comments/queue/dispatch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deckId, deckTitle, prompt: promptText }),
      });
      const data = (await res.json().catch(() => ({}))) as DispatchResult;
      if (!res.ok || !data.ok) {
        setDispatchResult({
          ok: false,
          error: data.error ?? `dispatch failed (${res.status})`,
        });
      } else {
        setDispatchResult(data);
      }
    } catch (e) {
      setDispatchResult({
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setDispatching(false);
    }
  };

  return (
    <motion.div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: CHROME_DURATION, ease: CHROME_EASE }}
      onClick={onClose}
    >
      <motion.div
        className="w-[640px] max-w-full rounded-2xl bg-[rgba(244,249,254,0.96)] backdrop-blur-xl backdrop-saturate-150 ring-1 ring-black/[0.06] shadow-[0_24px_60px_rgba(0,0,0,0.30)] flex flex-col max-h-[80vh]"
        initial={{ opacity: 0, y: 8, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 4, scale: 0.99 }}
        transition={{ duration: CHROME_DURATION, ease: CHROME_EASE }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 px-6 pt-5 pb-3 border-b border-black/[0.06]">
          <div>
            <h2 className="text-[15px] font-semibold text-[#111]">
              Send {count} comment{count === 1 ? "" : "s"} to Claude
            </h2>
            <p className="mt-1 text-[12px] leading-relaxed text-black/60">
              Send via GitHub opens a pull request you can review and
              merge. Copy lets you paste the prompt into a Claude Code
              session yourself.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="size-7 rounded-full text-black/50 hover:bg-black/[0.05] hover:text-black/80 transition-colors"
          >
            ×
          </button>
        </div>

        <div className="px-6 py-4 overflow-auto flex-1">
          <textarea
            readOnly
            value={promptText}
            className="w-full h-[40vh] resize-none rounded-lg bg-black/[0.04] ring-1 ring-black/[0.06] p-3 font-mono text-[11.5px] leading-relaxed text-black/80 focus:outline-none"
            onFocus={(e) => e.currentTarget.select()}
          />

          {/* Result strip — shown after a dispatch attempt. Lives
              inside the scroll area so a long error message doesn't
              push the action buttons off-screen. */}
          {dispatchResult && (
            <div
              className={`mt-3 rounded-lg p-3 text-[12px] leading-relaxed ${
                dispatchResult.ok
                  ? "bg-emerald-50 text-emerald-900 ring-1 ring-emerald-200"
                  : "bg-red-50 text-red-900 ring-1 ring-red-200"
              }`}
            >
              {dispatchResult.ok ? (
                <>
                  GitHub issue #{dispatchResult.issueNumber} created.
                  Claude is running — a PR will appear in ~1–2 minutes at{" "}
                  <a
                    href={dispatchResult.issueUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="underline underline-offset-2 hover:text-emerald-700"
                  >
                    the issue
                  </a>
                  .
                </>
              ) : (
                <>Failed: {dispatchResult.error}</>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-6 pb-5">
          <button
            type="button"
            onClick={onClose}
            className="rounded-full px-3.5 py-1.5 text-[12px] font-medium text-black/70 hover:bg-black/[0.05]"
          >
            Close
          </button>
          <button
            type="button"
            onClick={onCopy}
            className="rounded-full bg-black/[0.06] px-4 py-1.5 text-[12px] font-medium text-[#111] hover:bg-black/[0.10]"
          >
            {copied ? "Copied ✓" : "Copy"}
          </button>
          <button
            type="button"
            onClick={onDispatch}
            disabled={dispatching || dispatchResult?.ok}
            className="rounded-full bg-[#111] px-4 py-1.5 text-[12px] font-medium text-white hover:bg-black disabled:opacity-60 disabled:cursor-wait"
          >
            {dispatching
              ? "Sending…"
              : dispatchResult?.ok
                ? "Sent ✓"
                : "Send via GitHub"}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}
