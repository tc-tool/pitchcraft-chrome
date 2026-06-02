"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { useAccent } from "./useAccent";
import { useCurrentUser } from "./useCurrentUser";
import { canCurate } from "./permissions";
import { CHROME_PILL_BASE, CHROME_PILL_HOVER } from "./surfaceTokens";
import { CHROME_DURATION, CHROME_EASE } from "./motion";

interface AccentSwatchProps {
  /** Optional className for the wrapping container (positioning hooks). */
  className?: string;
}

/**
 * Default fallback shown in the swatch before the overlay resolves and
 * when no overlay is set. Matches the deck's hardcoded default accent
 * so the pill never renders a jarring placeholder color.
 */
const DEFAULT_ACCENT = "#E91647";

/**
 * Five quiet presets — a saturated brand red, two blues (one electric,
 * one cyan), a green, and near-black. Curated rather than a full
 * palette: the picker is for dialing a deck's defining accent, not for
 * fine-grained color work (the native <input type="color"> covers that).
 */
const PRESETS = ["#E91647", "#1E5BFF", "#00C4FF", "#16A34A", "#111111"];

/**
 * Creative-only "deck accent color" picker.
 *
 * Renders as a chrome pill (matches CommentBadge / PublishButton — same
 * frosted surface, h-[34px], hover lift) showing a small round swatch
 * of the current accent plus an "Accent" label. Click opens a
 * portal-to-body popover with a native color input, a synced hex field,
 * a row of preset swatches, and a "Reset to deck default" action.
 *
 * Any color change calls `setAccent`, which persists the overlay AND
 * retints the live deck instantly (see useAccent). Reset clears the
 * overlay and removes the live override.
 *
 * Permission: creative gate (canCurate). Returns null for everyone
 * else, so the pill simply doesn't exist in the DOM for
 * producers / clients. Mirrors PublishButton's self-gating exactly.
 */
export function AccentSwatch({ className = "" }: AccentSwatchProps) {
  const { user } = useCurrentUser();
  const { accent, setAccent, clearAccent, busy } = useAccent();
  const [open, setOpen] = useState(false);

  if (!user || !canCurate(user.email, user.role)) return null;

  const current = accent ?? DEFAULT_ACCENT;

  return (
    <div className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-print-hide
        aria-label="Deck accent color"
        className={`inline-flex h-[34px] items-center gap-2 rounded-full px-4 text-[10px] uppercase font-medium text-[#444] ${CHROME_PILL_BASE} ${CHROME_PILL_HOVER}`}
      >
        <span
          aria-hidden
          className="h-3.5 w-3.5 shrink-0 rounded-full ring-1 ring-black/[0.12] shadow-[inset_0_1px_0_rgba(255,255,255,0.25)]"
          style={{ backgroundColor: current }}
        />
        <span>Accent</span>
      </button>

      <AnimatePresence>
        {open && (
          <AccentPopover
            current={current}
            busy={busy}
            onPick={(color) => {
              void setAccent(color);
            }}
            onReset={() => {
              void clearAccent();
            }}
            onClose={() => setOpen(false)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

// ─── Popover ──────────────────────────────────────────────────────────

interface AccentPopoverProps {
  current: string;
  busy: boolean;
  onPick: (color: string) => void;
  onReset: () => void;
  onClose: () => void;
}

function AccentPopover({
  current,
  busy,
  onPick,
  onReset,
  onClose,
}: AccentPopoverProps) {
  // Portal-mount so the popover escapes the chrome-bar's transform
  // context (frosted backdrop needs to sit outside any ancestor
  // transform). Same pattern as PublishButton's confirm modal.
  const [portalNode, setPortalNode] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setPortalNode(document.body);
  }, []);

  // Hex field is kept in sync with the live `current` accent. Local
  // state lets the user type a partial hex without the parent fighting
  // the input on every keystroke; we only commit valid 6-digit hexes.
  const [hex, setHex] = useState(current);
  useEffect(() => {
    setHex(current);
  }, [current]);

  if (!portalNode) return null;

  const commitHex = (value: string) => {
    const v = value.trim();
    const normalized = v.startsWith("#") ? v : `#${v}`;
    if (/^#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/.test(normalized)) {
      onPick(normalized);
    }
  };

  return createPortal(
    <motion.div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 backdrop-blur-sm"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: CHROME_DURATION.panel, ease: CHROME_EASE.standard }}
      onClick={onClose}
    >
      <motion.div
        className="w-[340px] max-w-[92vw] rounded-2xl bg-[rgba(244,249,254,0.94)] backdrop-blur-xl backdrop-saturate-150 p-6 ring-1 ring-black/[0.06] shadow-[0_24px_60px_rgba(0,0,0,0.30)]"
        initial={{ opacity: 0, y: 8, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 4, scale: 0.99 }}
        transition={{ duration: CHROME_DURATION.panel, ease: CHROME_EASE.standard }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-[15px] font-semibold text-[#111]">Deck accent</h2>
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-black/65">
          Sets the deck&apos;s defining color. Live in staging instantly;
          baked into production on the next push.
        </p>

        {/* Color well + hex field. The native picker carries the swatch
            preview; the hex field mirrors it and accepts manual entry. */}
        <div className="mt-4 flex items-center gap-3">
          <label className="relative h-11 w-11 shrink-0 cursor-pointer overflow-hidden rounded-xl ring-1 ring-black/[0.08] shadow-[inset_0_1px_2px_rgba(0,0,0,0.04)]">
            <span
              aria-hidden
              className="absolute inset-0"
              style={{ backgroundColor: current }}
            />
            <input
              type="color"
              value={normalizeForColorInput(current)}
              onChange={(e) => onPick(e.target.value)}
              className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
              aria-label="Pick accent color"
            />
          </label>
          <input
            type="text"
            value={hex}
            onChange={(e) => setHex(e.target.value)}
            onBlur={(e) => commitHex(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitHex((e.target as HTMLInputElement).value);
            }}
            spellCheck={false}
            className="h-11 flex-1 rounded-xl bg-black/[0.05] px-3 text-[13px] font-medium text-[#111] ring-1 ring-black/[0.08] shadow-[inset_0_1px_2px_rgba(0,0,0,0.04)] outline-none placeholder:text-black/30"
            placeholder="#E91647"
            aria-label="Accent hex"
          />
        </div>

        {/* Preset swatches. */}
        <div className="mt-4 flex items-center gap-2">
          {PRESETS.map((preset) => {
            const active = current.toLowerCase() === preset.toLowerCase();
            return (
              <button
                key={preset}
                type="button"
                onClick={() => onPick(preset)}
                aria-label={`Accent ${preset}`}
                aria-pressed={active}
                className={`h-7 w-7 rounded-full ring-1 transition-[transform,box-shadow] duration-150 ease-out hover:-translate-y-0.5 ${
                  active
                    ? "ring-black/30 shadow-[0_0_0_2px_rgba(255,255,255,0.9),0_2px_8px_rgba(0,0,0,0.18)]"
                    : "ring-black/[0.12] shadow-[inset_0_1px_0_rgba(255,255,255,0.25)]"
                }`}
                style={{ backgroundColor: preset }}
              />
            );
          })}
        </div>

        <div className="mt-5 flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={onReset}
            disabled={busy}
            className="rounded-full px-3.5 py-1.5 text-[12px] font-medium text-black/70 hover:bg-black/[0.05] disabled:opacity-50"
          >
            Reset to deck default
          </button>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-full bg-[#111] px-4 py-1.5 text-[12px] font-medium text-white hover:bg-black disabled:opacity-60 disabled:cursor-wait"
          >
            Done
          </button>
        </div>
      </motion.div>
    </motion.div>,
    portalNode
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────

/**
 * The native `<input type="color">` only accepts a 6-digit `#rrggbb`
 * value — it silently rejects 3-digit shorthand and named colors,
 * snapping its swatch to black. Normalize to a 6-digit hex when we can,
 * else hand it a safe default so the control never renders as black for
 * a non-hex accent.
 */
function normalizeForColorInput(color: string): string {
  const v = color.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(v)) return v;
  if (/^#[0-9a-fA-F]{3}$/.test(v)) {
    const [r, g, b] = v.slice(1).split("");
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  return DEFAULT_ACCENT;
}
