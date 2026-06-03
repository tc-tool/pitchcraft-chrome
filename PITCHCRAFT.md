# Pitchcraft — Project Constitution

A working document for what Pitchcraft is, what it isn't, how it's built, and where it stands today.

This exists so the project stops being whatever the latest session imagined it to be. Every future decision — feature, design, infra — should be answerable against this file. If a proposed change can't be justified here, it doesn't ship.

---

## 1. Mission

Pitchcraft is a **controlled creative-deck system for high-control teams.** It exists so a creative director can:

- Build typography-first, cinematic pitch decks as code.
- Invite producers and clients to read, comment, and react — without ever editing visuals or code directly.
- Triage their feedback in one place.
- Hand the feedback to Claude, who implements the changes as reviewable git PRs.
- Publish a snapshot of the deck to clients when it's ready.

The whole system is about **funnelling feedback into an intentional, auditable loop** that ends with a deliberate publish — not a free-for-all CMS or a Figma clone.

### The feel: immediate and intuitive

Pitchcraft is a tool for producers and designers, not engineers. Inside the review interface, **every action is immediate.** Delete a slide and it's gone. Add one and it's there. Drag to reorder and it's reordered. None of these ever ask the user to understand, follow, or merge a pull request — that's a developer's concern and it must never surface mid-review.

The dividing line:

- **Structural review operations** — add slide, delete slide, reorder — are **live database state** (Redis overlays). Instant in staging, baked into production on PUSH. No Claude, no PR, no merge, ever.
- **Content/design authoring** — writing copy, restyling, implementing a creative comment ("make this headline bigger") — is genuine code. That still goes through the comment → Claude → PR loop, because it's a real source change that deserves review.

If a structural operation ever grows a PR/merge/"converge source" step, that's a regression. Rip it out. *Review behavior is instant; only authoring touches git.*

---

## 1.1 The three layers

Pitchcraft is built in three distinct layers. Every change to the system lives in exactly one of them. Mixing them up is the most common way the project balloons.

### Deck Skin — the per-pitch visual world

What changes wildly from pitch to pitch. Each deck's expressive identity: the slides, their typography, their motion, brand colors, custom slide types, eyebrows, surface treatments. A deck for a luxury fashion client doesn't look anything like a deck for a streaming franchise — and shouldn't.

Owned by: **the deck repo** (e.g. `tc-tool/pitchcraft`, `tc-tool/rings-s3`).

Lives in: `content/deck.content.ts`, `components/deck/slides/*`, the deck's own brand tokens, motion constants for slide transitions.

### Review Interface — the stable commenting and feedback system

The visible surface that producers, clients, and creatives use to leave feedback, triage threads, manage permissions, and trigger publish. This stays **consistent across every deck**, both visually and behaviorally. A producer reviewing the luxury fashion deck and a producer reviewing the streaming deck use the *same* comment panel, the *same* badge, the *same* triage flow, the *same* PUSH button.

This is the surface the Finisher polishes for **cross-deck consistency** — smooth, legible, identical from deck to deck. It's also what makes a Pitchcraft deck recognizable as a Pitchcraft deck.

Owned by: **the chrome package** (`@toolofna/pitchcraft-chrome`).

Lives in: `CommentPanel`, `CommentBadge`, `CommentsProvider`, `SlidePinLayer`, `MentionableTextarea`, `OutlineView`, `PublishButton`, `QueueToggle`, `QueueBar`, surface tokens, motion language.

### Pitchcraft Core — the invariant plumbing

The invisible system that makes any of this possible. Permissions (`canCurate`), the publish gate, GitHub issue generation, the Claude Code action loop, role-once persistence, the staging/production split, Slack notifications, persistence keys, namespacing by `deckId`.

This **never** changes per deck. If it changed per deck, decks would silently behave differently from each other, which is a worse failure than any visual inconsistency.

Owned by: **the chrome package's server entry + the deck factory + the workflow**.

Lives in: `store.ts`, `routeHandlers.ts`, `queueDispatch.ts`, `notifySlack.ts`, `authConfig.ts`, `permissions.ts`, the factory script, `.github/workflows/claude-triage.yml`.

### The map

| Layer              | Belongs to            | Variability             | What's in it                                                                                                                                                                                |
| ------------------ | --------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deck Skin          | The deck repo         | Wildly, per pitch       | Slides, slide types, deck typography, brand colors, slide motion, eyebrows, custom layouts, video/quote/cover treatments                                                                    |
| Review Interface   | The chrome package    | Stable across decks     | Comment panel, comment badge, mention typeahead, spatial pin layer, outline view, publish button, queue toggle, queue bar, surface tokens, chrome motion                                    |
| Pitchcraft Core    | Chrome server + infra | Invariant               | Permissions, role flow, persistence (Redis keys + namespacing), Slack notifier, publish-snapshot, queue/dispatch route, GitHub issue creation, Claude Code workflow, staging/production split |

### What this means for the Finisher

The Finisher agent polishes the system in **two separate passes**, not one universal pass:

1. **Per-deck skin polish.** Make this pitch feel bespoke, premium, on-brand for the client. Different choices each time.
2. **Shared review-interface polish.** Make the comment panel, badges, modals, motions, and labels feel consistent, smooth, and legible across **every** deck. Same choices applied everywhere.

These are different briefs. Don't conflate them.

### The litmus test

When a change is proposed, ask:

- "Does this make a single deck feel more itself?" → Deck Skin.
- "Does this make the review experience cleaner everywhere?" → Review Interface.
- "Does this change how the system actually works?" → Pitchcraft Core (and it had better be on purpose, with this document amended).

---

## 2. Non-Goals (what Pitchcraft is NOT)

Anything in this list should be **actively refused** unless we formally amend this document.

1. **Not a visual editor.** No drag-to-resize, no inline rich-text WYSIWYG, no font choosers, no free-form style editing. Visuals live in code; the chrome is for feedback only.

   **One deliberate exception (amended 2026-06): the deck-accent control.** A *single, creative-only* swatch sets one value — the deck's accent color (`meta.accent` → the `--deck-accent` CSS token) — through a Redis overlay, exactly like the reorder/delete overlays (instant in staging, baked into the production snapshot on PUSH). It is allowed because it is **one token, creative-gated, and the accent is a Deck-Skin concept the creative already owns** — and because the alternative (hand-editing source for every retint) fights the "immediate and intuitive" principle in §1. This is **not** a foothold for a general visual editor: no other visual property earns a GUI without a further amendment to this clause. Producers and clients never see the control.

   **Bounded exception (amended 2026-06): instant content edits.** Copy feedback is applied by *Claude*, not by hand: the deck's server calls the Claude API and writes the rewritten field(s) to a Redis **content overlay** — instant in staging, baked on PUSH — the same overlay model as accent and case-study. This stays on the right side of "not a visual editor" (and §2.2's "not a CMS") because there is **no WYSIWYG and no typing into the slide**: the creative leaves feedback in words, the AI rewrites the field, and `deck.content.ts` is reconciled later through deliberate authoring. **AI + creative remain the only writers to content**; producers/clients never author directly. It exists because a full GitHub-Action → rebuild round-trip for a one-line copy change fights the "immediate and intuitive" principle in §1 — minutes where it should be seconds.
2. **Not a CMS.** Producers/clients can comment but never directly write to `deck.content.ts`. The only path to source is the creative + Claude.

   **Bounded exception (amended 2026-06): the case-study picker.** Creative+producer may *select* (not author) past projects from Tool's own work archive (`toolofna.com/experience/work/`, read via its public WPGraphQL) and attach them as case-study slides at the end of the deck. This stays on the right side of "not a CMS" because: it's **selection from a fixed, external archive** (no free-form content authoring), it writes a **Redis overlay** (not `deck.content.ts`) that's baked into the snapshot on PUSH — the same model as the reorder/add-slide overlays — so **source is still only ever touched by creative + Claude**. It is not a license to hand-author arbitrary slide content through a GUI.
3. **Not a Figma replacement.** No multi-cursor live editing. No vector tools. No artboards.
4. **Not a fixed visual system at the deck level — and not a per-deck visual system at the review level.** Each pitch may flex wildly on its **Deck Skin** (slides, slide typography, brand world, motion, custom slide types). The **Review Interface** stays the same across every deck. The **Pitchcraft Core** never varies. See §1.1.
5. **Not a notifications platform.** Slack DMs on `@mention` is the full surface; no inbox, no digest emails, no in-app activity feed.
6. **Not a project management tool.** No assignees, due dates, milestones, Kanban. Comments are comments; the triage queue is for "what to implement next," not a backlog.
7. **Not a public-facing tool.** Each deck is gated by Google OAuth (and optionally a password). Decks are sent to specific stakeholders, not published to the world.
8. **Not multi-tenant SaaS.** Each deck is one Railway project, one GitHub repo, one subdomain. Scaling means more decks, not more users-per-deck.

---

## 3. Architecture

### 3.1 Three repos, one factory

```
~/Desktop/Tyler/toolOS/
├── pitchcraft-chrome/   shared editorial chrome (npm package)
├── Boilerplate/         deck template — also the active "pitchcraft" deck
├── factory/             one-shot deck spinner (new-deck, destroy-deck)
└── <slug>/              per-deck checkouts created by the factory
```

- **chrome** is a published npm package. Every deck pulls it via `git+https://github.com/tc-tool/pitchcraft-chrome.git#main` (or a specific commit hash). Updates ship to all decks via `npm update`. Chrome owns the **interaction model** (the behavior contract from §6.2); it also ships **default UI** components. Decks may use the default UI as-is or override the look — see §1.1 + §6.
- **Boilerplate** is both the template *and* the live Pitchcraft deck. The factory clones from it.
- **factory** is a shell script + GraphQL/CLI calls that handles GitHub repo creation, Railway provisioning, Cloudflare DNS, env vars, and prints a Google OAuth checklist.
- **Per-deck folders** (e.g. `rings-s3`) are factory output. Each is its own git repo and Railway project.

### 3.2 Chrome's hard rule: two entry points

```
@toolofna/pitchcraft-chrome           client-safe (React, hooks, tokens)
@toolofna/pitchcraft-chrome/server    Node-only (ioredis, NextAuth, route handlers)
```

If `getStore` or any ioredis-dependent symbol ever leaks into the client barrel, Webpack tries bundling `net` for the browser and the build dies. The split is load-bearing — don't merge them.

### 3.3 The stack

| Layer                  | Tool                                                  |
| ---------------------- | ----------------------------------------------------- |
| Framework              | Next.js 15 (App Router) + React 19 + TypeScript       |
| Styling                | Tailwind 3.4 (static class strings, no concat)        |
| Motion                 | Framer Motion 11 (CHROME_DURATION + CHROME_EASE only) |
| Auth                   | NextAuth v5 (Google OAuth)                            |
| Persistence            | Redis via ioredis (Railway managed)                   |
| Hosting                | Railway (per-deck project, Redis sidecar)             |
| DNS                    | Cloudflare (`toolofna.dev` zone, "DNS only", no proxy) |
| Notifications          | Slack Web API (single bot, DM mode)                   |
| Claude integration     | Anthropic Claude Code GitHub Action                   |
| Domain root            | `toolofna.dev` → each deck at `<slug>.toolofna.dev`   |

---

## 4. The Loop (the only flow that matters)

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│   Stakeholder leaves comment on /staging                        │
│              ↓                                                  │
│   @-mention fires Slack DM to mentioned users                   │
│              ↓                                                  │
│   Creative triages → checks comments → "Send to Claude"         │
│              ↓                                                  │
│   Server creates GitHub issue with compiled prompt + label      │
│              ↓                                                  │
│   anthropics/claude-code-action runs on GitHub                  │
│              ↓                                                  │
│   Claude commits the edit straight to main (no PR)               │
│              ↓                                                  │
│   (no PR, no merge — it just lands on main)                              │
│              ↓                                                  │
│   Railway auto-deploys → /staging reflects change in ~60s       │
│              ↓                                                  │
│   Creative clicks PUSH → snapshot written to Redis              │
│              ↓                                                  │
│   / (production) updates atomically; clients see new state      │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

The diagram shows the **deep/code path** (new slide types, layout, components). Two faster tiers sit in front of it, and **none of the three asks anyone to merge anything**:

- **Structural** (add / delete / reorder a slide, set accent, attach a case study) → an instant Redis overlay. No Claude, no git.
- **Copy** (rewrite a headline / body / bullet from feedback) → the deck's server calls the Claude API and writes the rewritten field(s) to a **content overlay** — visible on `/staging` in seconds. No GitHub Action, no rebuild, no PR.
- **Deep / code** → Send to Claude → GitHub issue → the Claude Code action commits **directly to `main`** (no PR, no merge) → Railway redeploys.

All three surface on `/staging` on their own. **PUSH is the only gate** — clients see nothing until the creative pushes, which snapshots the effective staging state (source + every overlay). There is no second review/merge gate anywhere, by design (see §1: *review behavior is instant; only deliberate authoring touches git, and even then never a merge step*).

Two views, two sources of truth, one gate:

| View          | Reads from                                  | Visible to                        |
| ------------- | ------------------------------------------- | --------------------------------- |
| `/staging`    | `deck.content.ts` live **+ overlays**       | Creative + invited stakeholders   |
| `/` (prod)    | Redis snapshot (effective state, or source) | Clients (signed-in via Google)    |

The PUSH button is the gate between the two. Staging churns (source edits *and* live overlays); production stays frozen until the creative deliberately pushes — at which point the snapshot captures the **effective staging state**: source with deletions removed, additions spliced in, producer reorder applied. What you saw in staging is exactly what ships.

---

## 5. What's shipped (truth as of this writing)

### 5.1 Working in production

- ✅ Per-slide threaded comments + `@mentions` typeahead
- ✅ Slack DM on `@mention` (resolves email → Slack user ID via `users.lookupByEmail`)
- ✅ Spatial pins (shift-click on a slide creates a coordinate-anchored comment)
- ✅ Outline view with producer drag-reorder (KV overlay, doesn't touch source)
- ✅ Role-once flow (creative / producer / client picked once per deck)
- ✅ Per-deck owner allowlist (`NEXT_PUBLIC_DECK_OWNER_EMAILS`) for high-trust actions
- ✅ Triage queue (creative checkboxes per comment → sticky "N queued" bar)
- ✅ Send to Claude → GitHub issue → action commits **directly to main** (no PR/merge); copy edits take the faster overlay path (§2.1 instant content edits)
- ✅ Copy-to-clipboard fallback if creative wants to paste into a manual Claude Code session
- ✅ PUSH (publish-to-production) snapshot gate
- ✅ Fixed "Tool" upfront — standard agency-intro sections (incl. WebGL scenes) that open every deck; backdrop + slides retint from one accent token
- ✅ Deck-accent control — single creative-only swatch (the §2.1 carve-out) sets `meta.accent`/`--deck-accent` via a Redis overlay; instant in staging, baked on PUSH
- ✅ Case-study picker (the §2.2 carve-out) — creative+producer search Tool's experiential work archive (WPGraphQL) and attach projects as case-study slides before Thank-you; Redis overlay, instant in staging, baked on PUSH
- ✅ Comment review-layer hardening — internal-vs-client audience gate (clients never see internal threads), richer anchors (element/region), "slide changed since this note" badge, orphaned-comment recovery in the outline
- ✅ Traceability chips on a comment — "Copy applied" (instant), "Sent to Claude · #N" (in flight), "Shipped to the deck" (landed). Built from `resolution.appliedAt` / `issueNumber` / `mergedAt`, which are stamped (and shallow-merged) as the loop advances
- ✅ "You were heard" Slack DMs — when feedback is applied (instant), dispatched to Claude, or its deep-code change lands on main, the people who left it get a direct ack. The merge rung is closed by the claude-triage workflow calling back to `/api/github/heard` (opt-in via `PITCHCRAFT_HEARD_SECRET` + repo var `PITCHCRAFT_DECK_URL`)
- ✅ PUSH publish-preview guardrail — the confirm modal shows the honest diff vs what's currently live ("2 slides edited, 1 added, reordered…") before publishing, computed from the same bytes PUSH writes (`buildEffectiveDeck` shared by preview + publish). "Publish anyway" when nothing changed
- ✅ Client review surface on the production link — with `NEXT_PUBLIC_ENABLE_CLIENT_COMMENTS=true`, clients comment on `/`; a signed-in viewer with no role is auto-assigned `client` (the team RolePicker is a staging concept), guarded so a deck owner is never mislabeled. Comments carry an `origin` (production/staging) stamp
- ✅ Inspect-element commenting — Alt-hover outlines any tagged `[data-anchor]` element (headline, a bullet, the proof stat…), Alt-click attaches a comment to THAT part (`anchor: element`), riding the spatial-pin pipeline. Untagged slides fall back to shift-click point pins
- ✅ Slide navigator (press `O`: zoom-out grid, type-to-jump) + per-slide poster thumbnails (`npm run deck:posters`)
- ✅ Factory script for one-shot deck spinup (~30 sec end-to-end excluding Google OAuth)
- ✅ Custom subdomain per deck via Cloudflare CNAME + Railway service domain
- ✅ Slack notifications, payment-free + zero per-deck setup

### 5.2 In flight or rough edges

- ✅ Instant content edits (the §2.1 carve-out) — copy feedback → Claude API → Redis content overlay, applied at render time. The fast path that replaces the GitHub round-trip for one-line copy changes; live in staging, baked on PUSH.
- 🟡 Element-anchor highlight-on-thread-hover — hovering an element-anchored thread highlights its pin (at the element's center) but not yet the element outline itself. Minor polish.
- 🟡 Inspect-element tagging covers the standard content slides (Cover, Statement, Bullets, Proof, Quote, Section Divider, Case Study); the bespoke "Tool" upfront slides aren't tagged yet (they fall back to point pins). Tag incrementally with `data-anchor`.
- 🟡 Per-deck password gate (`/unlock`) — half-built, `NavRingTorus` is a stub
- 🟡 The triage queue UI may collapse into a per-comment "Implement" button (open design question — see §9)
- 🟡 Some Boilerplate slide types are minimal (Cover, Statement, Bullets, Proof, Case Study, Section Divider, Placeholder, Quote, Video) — slide layouts are intentionally lean
- 🟡 Smoketest deck (`smoketest.toolofna.dev`) still standing — should be torn down once we trust the factory
- 🟡 Debug endpoints (`/api/debug/slack`) and probe comments still live in Pitchcraft from earlier diagnostics
- 🟡 `canEditSlideStatus` kept as deprecated alias for `canCurate` — remove on next major chrome bump

### 5.3 Decided and removed (don't re-add without amendment)

- ❌ Draft / Review / Approved slide-status pill — removed. Visibility is now driven by the PUSH gate and the `visibility` field, not per-slide status.
- ❌ Per-slide status overlay storage — gone from chrome + host.
- ❌ Top-bar PUSH button — moved into the floating cluster with Comments + Export.
- ❌ **PR / merge review step for content** — removed (amended 2026-06). Send-to-Claude commits directly to main; copy edits write an overlay. PUSH is the only gate to clients, so a PR/merge was a redundant second gate and pure friction. Don't re-add a content merge step.
- ❌ **Slide add/delete via Claude PR** — removed. Adding or deleting a slide used to dispatch a GitHub issue → Claude PR → merge → redeploy, with a "pending PR" strip in the outline. That dragged git into a producer's face for a one-click structural op. Replaced by instant Redis overlays (see §4, §6.3). The PR/merge step now exists *only* for content/design authoring. Do not re-add a "source convergence" PR for structural ops.
- ❌ Wide letter-spaced uppercase labels in chrome (`tracking-[0.28em]` etc.) — stripped from all chrome UI. Slide typography (cover eyebrows, statement labels) keeps its tracking because that's deck design, not chrome.

---

## 6. The visual rules, by layer

Different rules apply at each of the three layers from §1.1. Mixing them up is what creates either generic decks or inconsistent review experiences.

### 6.1 Deck Skin — flexible by design

There are **no enforced visual rules** at this layer. Each pitch is its own world.

A deck may use any palette, any typography, any motion personality, any slide treatments, any brand language. A deck may ship a single bespoke slide type for one moment in the pitch. A deck may build its own chrome bar treatment for the deck's identity (the bar that shows "PITCHCRAFT / STAGING / 01 / 08" at the top — that bar's *visuals* are a deck thing).

The only ceiling: the Deck Skin doesn't replace or modify the Review Interface (§6.2) and doesn't reach into Pitchcraft Core (§6.3).

### 6.2 Review Interface — the standard

These rules **DO** apply across every deck. The Review Interface is the system Pitchcraft trades on; reskinning it per deck would dilute it.

1. **Cool palette.** Surfaces use `rgba(244, 249, 254, X)`. No warm tones, no pure white surfaces.
2. **Suisse Intl** typeface, fallback to Inter.
3. **Dark primary actions.** `#111` filled, white text.
4. **Hairline rings.** `ring-black/[0.06]` baseline. Never thicker, never darker on focus.
5. **Recessed inputs.** Input wells are subtractive (`bg-black/[0.05]`); the caret is the focus indicator. No focus-ring intensification.
6. **Frosted glass.** `backdrop-blur-xl backdrop-saturate-150` on panels/popovers/pills. Requires escaping `transform` contexts via React portals.
7. **Centralized motion.** `CHROME_DURATION.<key>` and `CHROME_EASE.<key>`. No magic numbers.
8. **Tabular cells + optical nudges.** Single-digit count discs use `tabular-nums` + `translate-x-[1.5px]`.
9. **No wide letter-spacing on chrome labels.** Uppercase is fine; `tracking-[0.2em]+` is not. (Slide content typography in the Deck Skin is exempt.)
10. **Static Tailwind class strings.** No runtime concat. The host's Tailwind scanner has to find every class statically.

These live in `pitchcraft-chrome`. They are the Finisher's target when polishing for cross-deck consistency.

### 6.3 Pitchcraft Core — the behavior contract

These are the **invariants the Core enforces**. Skinning them is fine (Review Interface controls that); *changing their model* is a violation of the constitution.

- A **comment** has: id, deckId, slideId, parentId, body, mentions, optional pin, author email + role, status, timestamps.
- A **thread** is one root comment + chronological replies (one level deep, no replies-to-replies).
- An **`@mention`** by any role fires a Slack DM to the mentioned user (when token configured).
- The **role flow** is creative / producer / client, chosen once per deck, stored server-side, stamped on every comment they post.
- The **triage queue** is a curator-only side-index of comment ids flagged for implementation.
- **Send to Claude** opens a GitHub issue with the compiled prompt; the workflow opens a PR. This is for *content/design* changes only.
- **Structural slide ops** (add / delete / reorder) are instant Redis overlays — never a Claude PR. Add records `{id, afterId}`; delete records an id; reorder records an id order. The host materializes/filters slides from these at render time.
- **PUSH** snapshots the **effective staging state** (`deck.content.ts` with the structural overlays applied) into Redis; production reads the snapshot. Overlays are *not* cleared on PUSH — they remain the live truth until source is reconciled through deliberate authoring.
- The **owner allowlist** (`NEXT_PUBLIC_DECK_OWNER_EMAILS`) gates `canCurate` (triage, send, publish).
- All persistence is **namespaced by `deckId`** in Redis. Decks never share state.

Changing any of these requires an amendment to this document (see §12).

---

## 7. Operational Constraints (infra rules)

1. **Each deck = its own GitHub repo + Railway project + subdomain.** No shared databases between decks. Comments and snapshots are namespaced by `deckId`.
2. **Chrome is the only shared package.** Updates propagate via `npm update`. Don't fork chrome per-deck.
3. **The factory is the only path to a new deck.** Manual setup is allowed only for debugging and should be folded back into the factory.
4. **Per-deck secrets are per-deck.** AUTH_SECRET is regenerated per deck. Shared values (Google OAuth client, Slack bot token) are pulled from `~/.toolofna/factory.env` at factory-run time.
5. **DNS rule:** Cloudflare CNAME + TXT verification record, both proxy=OFF. Railway needs DNS-only.
6. **Railway service domain must exist before custom domain works.** The factory creates both in order; manual recoveries should follow the same order.
7. **`GITHUB_DISPATCH_TOKEN` + `PITCHCRAFT_GH_REPO`** must be set on each deck's Railway service for the Send-to-Claude flow.
8. **The Claude Code GitHub Action requires:**
   - `id-token: write` permission in the workflow
   - `anthropic_api_key` + `github_token` as `with:` inputs (not env vars)
   - `claude_args: "--permission-mode acceptEdits"` so file edits aren't blocked

These are foot-guns we've hit. Document them once; never hit them again.

---

## 8. Roles & Permissions

| Action                          | Creative | Producer | Client | Notes                                     |
| ------------------------------- | :------: | :------: | :----: | ----------------------------------------- |
| Read deck (`/staging` or `/`)   |    ✅    |    ✅    |   ✅   | Anyone signed in with verified Google email |
| Leave comments                  |    ✅    |    ✅    |   ✅   |                                           |
| `@`-mention users               |    ✅    |    ✅    |   ✅   | Notifies via Slack DM                     |
| Edit/delete own comments        |    ✅    |    ✅    |   ✅   |                                           |
| Resolve any comment             |    ✅    |    ✅    |   ✅   | Honor system — anyone can resolve         |
| Drag-reorder slides (overlay)   |    ✅    |    ✅    |   ❌   | Stored in KV; never touches source        |
| Add / delete slides (overlay)   |    ✅    |    ❌    |   ❌   | Instant Redis overlay; no PR. Creative-only |
| Queue a comment for Claude      |    ✅    |    ❌    |   ❌   | Sticky bar only visible to creative       |
| Send queue to Claude (PR)       |    ✅    |    ❌    |   ❌   | Content/design changes only → issue → PR  |
| Push to production              |    ✅    |    ❌    |   ❌   | Snapshots effective staging state to Redis |
| Edit `deck.content.ts`          |    ✅    |    ❌    |   ❌   | Via Claude or manually in editor          |

The `canCurate` gate (creative role + email in `NEXT_PUBLIC_DECK_OWNER_EMAILS`) controls all high-trust actions. Producers/clients never see those affordances in the DOM — the chrome components self-gate.

---

## 9. Open Questions

These need decisions before they balloon.

1. **Queue + Send button vs per-comment Implement button.** The current model batches: check boxes → click Send. The alternative: each comment has an Implement button; one click = one PR. Tradeoffs:
   - Batch: fewer PRs, more "set it up + send" friction.
   - Per-comment: more PRs (one per feedback), no separate triage state, but every click commits to firing.
   - **Default position until decided:** keep the batch flow; revisit after using it on one full pitch.

2. **`@claude` auto-fire.** Should mentioning `@claude` in a comment automatically queue it? Only from creative? Doing it from clients would let clients spam PRs.
   - **Default position:** no auto-fire. Creative explicitly chooses what gets implemented.

3. **Slide content typography.** The cover slide and section headers still use `tracking-[0.28em]` etc. Tyler's complaint about letter-spacing only targeted chrome. Whether to extend the cleanup to slide content is a deck-design decision per pitch, not a system-wide one.

4. **Password gate.** Half-built. Decision needed: is it a per-deck feature (one password protects a deck regardless of who's signed in) or per-stakeholder (link tokens)? Current half-built version assumes per-deck.

5. **What happens to resolved comments?** They stay in Redis indefinitely. At what volume do we need a cleanup story? Not urgent at current scale.

6. **Multi-creative decks.** Currently one creative per deck (the owner). If two creatives collaborate, who controls PUSH? Defer until it comes up.

7. **Client authentication on the production review surface.** Clients comment on `/` via the same Google sign-in the team uses; a signed-in viewer with no role is auto-assigned `client`. This reuses the verified-identity + audience model with zero new infra, but assumes the client has (and will use) a Google account.
   - **Default position (decided 2026-06):** Google sign-in + auto-`client`. Revisit only if a real client balks — the fallback would be a lightweight magic-link/email provider (next-auth email) or a name-only link-token identity, both of which would relax the "audience derives from verified role" guarantee and need their own design pass. The client surface, audience gating, and `origin` stamping are auth-method-agnostic, so swapping the sign-in layer later doesn't redo Phase 3.

8. **Boundary cases between Deck Skin and Review Interface.** Mostly clear (slides = Skin; comment panel = Review Interface), but a few edges need calling out as they come up. Example: the top chrome bar that shows "PITCHCRAFT / STAGING / 01 / 08" — currently the bar layout lives in the host (Deck Skin territory) but the typography style was conformed to Review Interface rules. That's probably fine, but worth being explicit when it next gets touched: deck identity (the bar's *visual identity*) is Skin; standardized info elements inside it (slide counter rhythm, mode badge) are Review Interface. **Default position:** when in doubt, treat it as Review Interface unless a specific pitch needs it to express deck identity, and document the choice in the deck repo.

---

## 10. Anti-Patterns (refuse these on sight)

If a future session proposes any of these, push back hard.

- **"Let's add a quick visual editor for X"** — see §2.1. Visuals stay in code. The **only** carved-out exception is the single creative-only deck-accent control (§2.1); any *other* "let me tweak this visual property in a GUI" request is still a no without amending §2.1.
- **"Let's let producers edit copy directly"** — see §2.2. The path to source is creative + Claude only. The lone carve-out is the case-study picker (§2.2): *selecting* fixed archive entries into an overlay is allowed; hand-authoring arbitrary slide copy through a GUI is not.
- **"Let's add a notifications inbox in the deck"** — see §2.5. Slack is the surface.
- **"Let's restyle the comment panel for this deck"** — no. See §1.1 + §6.2. The Review Interface is shared by every deck. Restyle the Deck Skin, not the Review Interface.
- **"Let's change how comments work for this client"** — no. See §1.1 + §6.3. Pitchcraft Core never varies per deck.
- **"Let's bypass the PUSH gate for emergencies"** — no. The PUSH gate is the entire point of the staging/production split.
- **"Let's add a second 'send' mechanism for X scenario"** — collapse, don't multiply. Every new send button is a new mental surface.
- **"Let's route this structural op (add/delete/reorder) through a Claude PR / source-convergence step"** — no. See §1 + §4. Structural review ops are instant overlays. Only content/design authoring touches git. A PR/merge step on a one-click structural action is the exact "dev hellscape" this tool exists to avoid.
- **"Let's add a database for X (not Redis)"** — Redis is the only persistence. If a need arises it can't model, we discuss in this document first.
- **"Let's let chrome import `DeckSlide`"** — no. Chrome is content-agnostic. It speaks in `slideId: string` and that's it.
- **"Let's hardcode a deck-specific value in chrome"** — chrome is shared by all decks. Per-deck variability lives in the Deck Skin (the host's `content/` and `components/deck/slides/`), not in chrome.

When a change is proposed, ask which layer it belongs in. If the answer is "Deck Skin" — flex freely. If it's "Review Interface" — apply once, across every deck, consistently. If it's "Pitchcraft Core" — amend this document first or refuse.

---

## 11. Project status — pieces, status, owner

| Piece                                  | Status            | Notes                                              |
| -------------------------------------- | ----------------- | -------------------------------------------------- |
| Comment system (CRUD, threads, pins)   | ✅ Shipped        |                                                    |
| Mentions + Slack DMs                   | ✅ Shipped        | DM mode (no shared channel) default                |
| Triage queue + Send to Claude          | ✅ Shipped        | Works end to end; design might change (§9.1)       |
| Claude Code GitHub Action integration  | ✅ Working        | Permission-mode `acceptEdits`, id-token write       |
| PUSH snapshot gate                     | ✅ Shipped        | Per-deck `published` key in Redis                  |
| Factory script                         | ✅ Working        | Inc. CF DNS, Railway env, custom domain, PR setup  |
| Outline reorder overlay                | ✅ Shipped        |                                                    |
| Password gate (`/unlock`)              | 🟡 Half-built     | `NavRingTorus` stubbed; flow not tested            |
| Multi-deck rollout via factory         | 🟡 Tested once    | `smoketest` deck stood up cleanly; needs more reps |
| Slide-content typography cleanup       | 🟡 Open question  | See §9.3                                           |
| `canEditSlideStatus` deprecation alias | 🟡 Lingering      | Remove on next major chrome bump                   |
| Smoketest deck                         | 🟡 Should tear down | Use as a sanity check then destroy                |
| Pitchcraft debug endpoints             | 🟡 Should remove  | `/api/debug/slack` + probe comments                |
| Triage UX (queue vs per-comment)       | ❓ In design      | See §9.1                                           |
| `@claude` auto-fire                    | ❓ In design      | See §9.2                                           |

---

## 12. Amendment rules

This document changes when:

1. **A non-goal flips.** Decision logged with rationale; section updated.
2. **A design constraint relaxes.** Same.
3. **An open question is decided.** Move from §9 to §5 with the decision summary.
4. **A new feature lands.** Update §5; check it isn't contradicting §2 or §10.

Changes are commits to this file in the toolOS repo (or wherever Tyler decides this constitution should live long-term). Every session should re-read the latest version of this document before proposing changes.

---

*Document is a living artifact. Last touched: see git log of the toolOS repo.*
