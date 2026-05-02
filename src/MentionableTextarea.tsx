"use client";

import {
  forwardRef,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ChangeEvent,
} from "react";
import { useDeckUsers } from "./useDeckUsers";
import { tintForAuthor } from "./authorColor";
import { PANEL_SURFACE } from "./surfaceTokens";
import type { UserRecord } from "./types";

interface MentionableTextareaProps {
  value: string;
  onChange: (next: string) => void;
  /** Triggered on Cmd/Ctrl+Enter when the typeahead isn't open. */
  onSubmit?: () => void;
  placeholder?: string;
  rows?: number;
  autoFocus?: boolean;
  className?: string;
  style?: CSSProperties;
}

interface MentionState {
  /** What the user has typed after the @ (excluding the @ itself). */
  query: string;
  /** Index of the @ in the textarea value. */
  atIdx: number;
  /** Index of the cursor at the time of detection. */
  cursorIdx: number;
}

export interface MentionableTextareaHandle {
  focus: () => void;
}

/**
 * Textarea with @mention typeahead. When the user types `@` (preceded
 * by start-of-text or whitespace), a small picker opens beneath the
 * textarea showing matching deck users. Picking inserts a `<@email>`
 * token at the cursor.
 *
 * Keyboard: ArrowUp/Down to navigate, Enter to pick, Esc to cancel.
 * When typeahead isn't open, Cmd/Ctrl+Enter calls onSubmit.
 *
 * Storage format is `<@email>` so the rendering layer can resolve the
 * display name and color at render time (and stay accurate if the
 * user updates their Google profile).
 */
export const MentionableTextarea = forwardRef<
  MentionableTextareaHandle,
  MentionableTextareaProps
>(function MentionableTextarea(
  {
    value,
    onChange,
    onSubmit,
    placeholder,
    rows = 3,
    autoFocus = false,
    className = "",
    style,
  },
  ref
) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const { users } = useDeckUsers();

  useImperativeHandle(ref, () => ({
    focus: () => taRef.current?.focus(),
  }));

  const [mention, setMention] = useState<MentionState | null>(null);
  const [highlight, setHighlight] = useState(0);

  const filtered = useMemo(() => {
    if (!mention) return [] as UserRecord[];
    const q = mention.query.toLowerCase();
    if (!q) return users.slice(0, 5);
    return users
      .filter((u) => {
        const email = u.email.toLowerCase();
        const name = (u.name ?? "").toLowerCase();
        return email.includes(q) || name.includes(q);
      })
      .slice(0, 5);
  }, [mention, users]);

  const detectMention = (text: string, cursor: number) => {
    const before = text.slice(0, cursor);
    // @ must start the text or be preceded by whitespace; query allows
    // alphanum, dot, underscore, dash, plus, and @ (so partial emails
    // like `john@` typeahead).
    const match = before.match(/(^|\s)@([\w.+\-@]*)$/);
    if (!match) {
      setMention(null);
      return;
    }
    const query = match[2];
    const atIdx = cursor - query.length - 1; // -1 for the @
    setMention({ query, atIdx, cursorIdx: cursor });
    setHighlight(0);
  };

  const handleChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    const next = e.target.value;
    onChange(next);
    const cursor = e.target.selectionStart ?? next.length;
    detectMention(next, cursor);
  };

  const insertMention = (user: UserRecord) => {
    if (!mention || !taRef.current) return;
    const before = value.slice(0, mention.atIdx);
    const after = value.slice(mention.cursorIdx);
    const insertion = `<@${user.email.toLowerCase()}> `;
    const next = before + insertion + after;
    onChange(next);
    setMention(null);

    // Restore cursor to just after the inserted token.
    const newPos = before.length + insertion.length;
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (!ta) return;
      ta.setSelectionRange(newPos, newPos);
      ta.focus();
    });
  };

  const handleKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (mention && filtered.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlight((i) => (i + 1) % filtered.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlight((i) => (i - 1 + filtered.length) % filtered.length);
        return;
      }
      if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        insertMention(filtered[highlight]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMention(null);
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        insertMention(filtered[highlight]);
        return;
      }
    }

    if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && onSubmit) {
      e.preventDefault();
      onSubmit();
    }
  };

  return (
    <div className="relative">
      <textarea
        ref={taRef}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onClick={(e) =>
          detectMention(
            value,
            (e.target as HTMLTextAreaElement).selectionStart ?? 0
          )
        }
        onBlur={() => {
          // Defer to allow click on dropdown item to register first.
          setTimeout(() => setMention(null), 120);
        }}
        placeholder={placeholder}
        rows={rows}
        autoFocus={autoFocus}
        style={style}
        className={className}
      />

      {mention && filtered.length > 0 && (
        <div
          className={`absolute left-0 right-0 top-full z-50 mt-2 max-h-60 overflow-y-auto rounded-2xl py-1.5 [isolation:isolate] ${PANEL_SURFACE}`}
        >
          {filtered.map((u, i) => {
            const active = i === highlight;
            const initials = (u.name ?? u.email).charAt(0).toUpperCase();
            return (
              <button
                key={u.email}
                type="button"
                onMouseDown={(e) => {
                  // Prevent textarea blur before click registers
                  e.preventDefault();
                }}
                onClick={() => insertMention(u)}
                onMouseEnter={() => setHighlight(i)}
                className={`flex w-full items-center gap-3 px-3 py-2 text-left transition-colors duration-150 ease-out ${
                  active ? "bg-black/[0.04]" : "bg-transparent hover:bg-black/[0.03]"
                }`}
              >
                <span
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-[#111]"
                  style={{ backgroundColor: tintForAuthor(u.email, 0.45) }}
                  aria-hidden
                >
                  {initials}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium text-[#111]">
                    {u.name ?? u.email}
                  </span>
                  <span className="block truncate text-[11px] text-[#888]">
                    {u.email}
                  </span>
                </span>
                <span className="text-[10px] uppercase tracking-[0.14em] text-[#999]">
                  {u.role}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
});
