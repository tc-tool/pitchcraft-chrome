"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { usePublish } from "./usePublish";
import { useCurrentUser } from "./useCurrentUser";
import { useIsVerifiedTeam } from "./useIsVerifiedTeam";
import { canCurate } from "./permissions";
import { CHROME_DOCK_ITEM_PRIMARY } from "./surfaceTokens";
import { CHROME_DURATION, CHROME_EASE } from "./motion";
import type { PublishPreview } from "./types";

interface PublishButtonProps {
  /**
   * The current host content blob to snapshot. Opaque to the chrome —
   * passed through unchanged to the server. Typically `deckContent`
   * from the host's `content/deck.content.ts`.
   */
  content: unknown;
  /**
   * Optional label override. Default is "PUSH" — short on purpose so
   * the pill matches the height + visual weight of CommentBadge.
   */
  label?: string;
  /**
   * Optional className for the wrapping container (positioning hooks).
   */
  className?: string;
  /**
   * When true, renders as the primary bare dock item — a dark #111
   * filled rounded item (CHROME_DOCK_ITEM_PRIMARY) without the
   * white-ring/shadow capsule treatment, so a surrounding dock container
   * provides the separation. PUSH stays the one emphasized "ship"
   * control either way. Default false → the original framed capsule.
   */
  bare?: boolean;
  /**
   * Optional async loader for the publish preview — the honest diff of
   * what this PUSH changes vs what's currently live. When provided, the
   * confirm modal fetches it on open and lists the changes before the
   * creative commits (the guardrail). Host-supplied because computing the
   * diff needs the deck's content schema; chrome just renders the neutral
   * result. Omitted → the modal shows the generic copy, as before.
   */
  loadPreview?: () => Promise<PublishPreview>;
}

/**
 * Creative-only "Publish to production" button.
 *
 * Renders as a chrome pill (matches CommentBadge / SlideStatusPill).
 * Shows last-published timestamp underneath when there's a snapshot
 * on record. Click opens a confirm modal; confirming uploads the
 * current `content` to the server which becomes the source for the
 * production view.
 *
 * Permission: same gate as slide-status writes (creative role + email
 * in the NEXT_PUBLIC_DECK_OWNER_EMAILS allowlist). Returns null for
 * everyone else, so the button simply doesn't exist in the DOM for
 * producers/clients.
 *
 * Stays empty until `useCurrentUser` resolves so we don't flash the
 * button before knowing whether the viewer is allowed to see it.
 */
export function PublishButton({
  content,
  label = "PUSH",
  className = "",
  bare = false,
  loadPreview,
}: PublishButtonProps) {
  const { user } = useCurrentUser();
  const isVerifiedTeam = useIsVerifiedTeam();
  const { lastPublished, isPublishing, error, publish } = usePublish();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [justPublished, setJustPublished] = useState(false);

  // Brief "Published ✓" affordance after a successful upload. Clears
  // itself so the button doesn't permanently sit in a different state.
  useEffect(() => {
    if (!justPublished) return;
    const t = setTimeout(() => setJustPublished(false), 2200);
    return () => clearTimeout(t);
  }, [justPublished]);

  if (!user || !canCurate(user.email, user.role, { isVerifiedTeam }))
    return null;

  const onConfirm = async () => {
    try {
      await publish(content);
      setConfirmOpen(false);
      setJustPublished(true);
    } catch {
      // error state is exposed via the hook — modal stays open so
      // the user can see what failed
    }
  };

  return (
    <div className={`relative ${className}`}>
      {/* PUSH is the one consequential, "ship to production" action, so
          it deliberately departs from the frosted utility pills
          (Comments, Export) and takes the dark primary treatment from
          the design system. The solid #111 capsule with a white hairline
          ring + soft shadow reads cleanly on the black deck and pulls the
          eye as the deliberate action it is. The up-arrow lifts a hair on
          hover — a quiet nod to "push up". */}
      <button
        type="button"
        onClick={() => setConfirmOpen(true)}
        disabled={isPublishing}
        className={
          bare
            ? // Bare: primary dock item — dark #111 fill, no capsule
              // ring/shadow/lift (the dock container separates it). Still
              // the one emphasized "ship" control in the dock.
              `group ${CHROME_DOCK_ITEM_PRIMARY} disabled:opacity-60 disabled:cursor-wait`
            : // Framed: the standalone dark primary capsule with white
              // hairline ring + soft shadow + hover lift.
              "group inline-flex h-[34px] items-center gap-1.5 rounded-full bg-[#111] pl-3.5 pr-4 text-[10px] font-medium uppercase text-white ring-1 ring-white/[0.16] shadow-[inset_0_1px_0_rgba(255,255,255,0.10),0_3px_12px_rgba(0,0,0,0.42)] transition-[transform,background-color,box-shadow,ring-color] duration-150 ease-out hover:-translate-y-0.5 hover:bg-black hover:ring-white/[0.30] hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.14),0_10px_26px_rgba(0,0,0,0.55)] active:translate-y-0 active:duration-100 disabled:opacity-60 disabled:cursor-wait"
        }
      >
        <PushGlyph pushed={justPublished} />
        {justPublished ? "Pushed" : label}
      </button>

      {/* Last-pushed timestamp moved into the confirm modal — keeping
          it inline next to the pill made the cluster height
          inconsistent and pulled the eye off the active slide. The
          stamp is still readable: open the modal to see when. */}

      <AnimatePresence>
        {confirmOpen && (
          <PublishConfirmModal
            onCancel={() => setConfirmOpen(false)}
            onConfirm={onConfirm}
            lastPublished={lastPublished}
            error={error}
            isPublishing={isPublishing}
            loadPreview={loadPreview}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

// ─── Push glyph ───────────────────────────────────────────────────────
//
// Up-arrow by default (nudges up on hover via the parent's `group`),
// swapping to a checkmark for the brief "Pushed" success window. Drawn
// with currentColor so it inherits the button's white ink.

function PushGlyph({ pushed }: { pushed: boolean }) {
  const common = {
    width: 12,
    height: 12,
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };

  if (pushed) {
    return (
      <svg {...common}>
        <path d="M3.5 8.5l3 3 6-7" />
      </svg>
    );
  }

  return (
    <svg
      {...common}
      className="transition-transform duration-150 ease-out group-hover:-translate-y-px"
    >
      <path d="M8 13V3.5" />
      <path d="M3.75 7.75 8 3.5l4.25 4.25" />
    </svg>
  );
}

// ─── Confirm modal ────────────────────────────────────────────────────

interface PublishConfirmModalProps {
  onCancel: () => void;
  onConfirm: () => void;
  lastPublished: { publishedAt: string; publishedBy: string } | null;
  error: string | null;
  isPublishing: boolean;
  loadPreview?: () => Promise<PublishPreview>;
}

function PublishConfirmModal({
  onCancel,
  onConfirm,
  lastPublished,
  error,
  isPublishing,
  loadPreview,
}: PublishConfirmModalProps) {
  // Portal-mount so the modal escapes the chrome-bar's transform
  // context. Without this, fixed positioning gets trapped inside the
  // bar and the modal renders inline instead of as an overlay.
  const [portalNode, setPortalNode] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setPortalNode(document.body);
  }, []);

  // The guardrail: fetch the honest diff of what this PUSH will change so
  // the curator sees it before committing. Fire once on open. A failure
  // is non-fatal — they can still publish (the publish route re-bakes
  // from the same overlays, so the preview is advisory, not a gate).
  const [preview, setPreview] = useState<PublishPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  useEffect(() => {
    if (!loadPreview) return;
    let cancelled = false;
    setPreviewLoading(true);
    setPreviewError(null);
    loadPreview()
      .then((p) => {
        if (!cancelled) setPreview(p);
      })
      .catch((e: unknown) => {
        if (!cancelled)
          setPreviewError(
            e instanceof Error ? e.message : "couldn't load the diff"
          );
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [loadPreview]);

  const noChanges =
    !!preview && !preview.firstPublish && !preview.hasChanges;

  if (!portalNode) return null;

  return createPortal(
    <motion.div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 backdrop-blur-sm"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: CHROME_DURATION.panel, ease: CHROME_EASE.standard }}
      onClick={onCancel}
    >
      <motion.div
        className="w-[420px] max-w-[92vw] rounded-2xl bg-[rgba(244,249,254,0.94)] backdrop-blur-xl backdrop-saturate-150 p-6 ring-1 ring-black/[0.06] shadow-[0_24px_60px_rgba(0,0,0,0.30)]"
        initial={{ opacity: 0, y: 8, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 4, scale: 0.99 }}
        transition={{ duration: CHROME_DURATION.panel, ease: CHROME_EASE.standard }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-[15px] font-semibold text-[#111]">
          Publish current state to production?
        </h2>
        <p className="mt-2 text-[12.5px] leading-relaxed text-black/65">
          Replaces what visitors see at <code>/</code> with the current
          state of staging. Staging stays live and unchanged.
        </p>

        {/* The guardrail: the honest diff vs what's currently live. Only
            renders when the host supplied a loader; otherwise the modal is
            the generic confirm it always was. */}
        {loadPreview && (
          <div className="mt-3.5 rounded-xl bg-black/[0.035] p-3 ring-1 ring-black/[0.05]">
            {previewLoading && (
              <p className="text-[12px] text-black/50">
                Checking what will change…
              </p>
            )}
            {previewError && !previewLoading && (
              <p className="text-[12px] leading-relaxed text-amber-700">
                Couldn’t compute the diff ({previewError}). You can still
                publish — the result is the current staging state.
              </p>
            )}
            {preview && !previewLoading && (
              <>
                {preview.firstPublish ? (
                  <p className="text-[12.5px] leading-relaxed text-black/75">
                    {preview.lines[0]}
                  </p>
                ) : preview.hasChanges ? (
                  <>
                    <p className="text-[10.5px] font-medium uppercase tracking-wide text-black/45">
                      This push will change
                    </p>
                    <ul className="mt-2 flex flex-col gap-1.5">
                      {preview.lines.map((line, i) => (
                        <li
                          key={i}
                          className="flex items-center gap-2 text-[12.5px] text-black/80"
                        >
                          <span
                            aria-hidden
                            className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#1E5BFF]"
                          />
                          {line}
                        </li>
                      ))}
                    </ul>
                  </>
                ) : (
                  <p className="flex items-center gap-2 text-[12.5px] text-black/60">
                    <span
                      aria-hidden
                      className="h-1.5 w-1.5 shrink-0 rounded-full bg-black/25"
                    />
                    {preview.lines[0]}
                  </p>
                )}
              </>
            )}
          </div>
        )}

        {lastPublished && (
          <p className="mt-3 text-[11px] uppercase text-black/45">
            Currently live: published {timeAgo(lastPublished.publishedAt)} by{" "}
            {lastPublished.publishedBy}
          </p>
        )}

        {error && (
          <p className="mt-3 text-[12px] text-red-600">
            Publish failed: {error}
          </p>
        )}

        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={isPublishing}
            className="rounded-full px-3.5 py-1.5 text-[12px] font-medium text-black/70 hover:bg-black/[0.05] disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={isPublishing}
            className="rounded-full bg-[#111] px-4 py-1.5 text-[12px] font-medium text-white hover:bg-black disabled:opacity-60 disabled:cursor-wait"
          >
            {isPublishing
              ? "Publishing…"
              : noChanges
                ? "Publish anyway"
                : "Publish"}
          </button>
        </div>
      </motion.div>
    </motion.div>,
    portalNode
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────

/**
 * "2 hours ago" / "just now". Coarse on purpose — the exact second
 * doesn't matter for a publish stamp, and re-rendering on a tick
 * would be noise. Recomputed on each parent render.
 */
function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const seconds = Math.max(1, Math.round((now - then) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}
