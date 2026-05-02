# Pitchcraft Chrome — Master

This package is the **editorial chrome** that gets installed into every Pitchcraft deck. Comment panel, comment badge, spatial pins, slide-status overlay, mention typeahead, surface tokens, motion language. It is consumed by many decks; what you change here ships to all of them on the next `npm update`.

## What lives here

- **UI components**: `CommentPanel`, `CommentBadge`, `SlidePinLayer`, `MentionableTextarea`
- **State / hooks**: `CommentsProvider`, `useCommentsForSlide`, `useCurrentUser`, `useDeckUsers`, `useSlideStatuses`, `useReorder`, `useSlideMutations`
- **Server**: `routeHandlers` (re-exported so the host's `app/api/...` is a one-liner), `authConfig`, `store`
- **Tokens**: surface recipes (`PANEL_SURFACE`, `INPUT_BASE`, `CHROME_PILL_BASE/HOVER`, etc.) and motion (`CHROME_DURATION`, `CHROME_EASE`)
- **Permissions**: `canEditSlideStatus`, `canReorderSlides`, `deckOwnerEmails`
- **Pure helpers**: `applyReorder` (overlay → ordered slides)

## Two entry points: `.` and `./server`

The package exposes two import paths and the split is **load-bearing** — don't merge them:

- **`@toolofna/pitchcraft-chrome`** (the default barrel, `src/index.ts`) — client-safe. React components, hooks, tokens, permissions, types, pure helpers. Anything a client component or shared module can import.
- **`@toolofna/pitchcraft-chrome/server`** (the server-only barrel, `src/server.ts`) — `getStore`, all route handlers, NextAuth helpers (`authHandlers`, `auth`, `signIn`, `signOut`). Anything that uses Node-only APIs (`ioredis` → `net` socket).

Why this split exists: the data store uses `ioredis`, which depends on Node's `net` module. If `getStore` ever gets re-exported from the main barrel, *any* client component that imports from `@toolofna/pitchcraft-chrome` causes Webpack to try bundling `ioredis` for the browser, which fails ("Module not found: Can't resolve 'net'"). The split is the boundary that prevents that leak.

When wiring host code:
- `app/page.tsx`, route handlers, anything server-side → `from "@toolofna/pitchcraft-chrome/server"`
- Client components, deck composition, slide pills → `from "@toolofna/pitchcraft-chrome"`
- Files that need both (e.g. an API route using `getStore` + `canEditSlideStatus`) → two imports, one from each path

## Design rules (the things this chrome enforces)

- **Cool palette.** Translucent off-white surfaces in the `rgba(244, 249, 254, X)` family. Never warm tones. Never pure white surfaces.
- **Suisse Intl** is the chrome's typeface. Falls back to Inter via the host.
- **Recessed input wells.** Inputs are subtractive (`bg-black/[0.05]`) — they read as pressed *into* the panel, not placed on top. **Never add focus ring intensification or background changes** — focus is the caret blinking inside.
- **Dark primary.** `#111` filled, white text. No saturated accent colors for primary actions.
- **Hairline rings.** `ring-black/[0.06]` baseline. Never thicker rings; never darker rings on focus.
- **Frosted glass.** `backdrop-blur-xl backdrop-saturate-150` is the chrome's signature surface treatment. The pin popover and panel both use it; it requires being outside any ancestor with a CSS transform (the popover uses a portal for this reason).
- **Motion language is centralized.** Every chrome interaction draws from `CHROME_DURATION` and `CHROME_EASE`. Don't scatter ad-hoc magic numbers.
- **Tabular cells, optical nudges.** Single-digit counts in dark discs use `tabular-nums` + a `1.5px` translate-x to compensate for Suisse Intl's left-leaning sidebearings.

## Architectural rules

- **Public API is small.** Only what's exported from `src/index.ts` is contract. Everything else is private and can be refactored freely.
- **No deck-specific assumptions.** Don't import `DeckSlide`, don't reach into the host's content schema. The chrome talks about `slideId` (a string) and that's it. The host bridges between its slide types and the chrome.
- **Server exports are explicit.** Anything the host's `app/api/...` route handlers need is exported from the barrel. Don't expect hosts to import from internal paths.
- **Tailwind classes are static strings.** No runtime concatenation of class names that Tailwind can't statically scan — the host's Tailwind content array includes this package's source for tree-shaking.
- **Author tints are info, not chrome.** Per-author colors (the AUTHOR_PALETTE) carry identity, not visual style. Don't unify them with chrome surfaces.

## What does NOT belong here

- The deck spine (FixedViewportShell, useSectionScroller, SECTION_TRAVEL constants) — that's the deck's framework.
- Slide types (CoverSlide, BulletsSlide, etc.) — deck-level content shapes.
- The chrome bar / nav dots / export PDF button — deck composition that *uses* chrome tokens.
- `SlideStatusPill` — the integration layer in the deck that consumes `useSlideStatuses` + `canEditSlideStatus` + `CHROME_PILL_BASE`. It knows about `DeckSlide`; the chrome doesn't.
- Per-deck content (deck.content.ts).
- Brand tokens for the deck (slide typography, primary colors used in slides).

## Versioning

Bump `version` in `package.json` when changing the public API (additions are minor, breaks are major). Patch version for visual fixes that don't change the surface. Decks pull updates via `npm update @toolofna/pitchcraft-chrome`.

## Working in here

This is the master file. Open Claude in this directory and work on chrome-only changes. To see chrome in context of a real deck during development, use `npm link` from a deck repo, or use `"file:../pitchcraft-chrome"` in the deck's package.json (the dev workflow we use locally).

## Sharp edge: peer-dep dual-instance bug (don't undo these guards)

When this package is consumed via `file:` link, it's symlinked into the deck's `node_modules`. Three places have to be configured *together* or you get a `[next-auth]: useSession must be wrapped in a <SessionProvider />` runtime error (or a `Cannot find module 'next-auth'` build error):

1. **This package's `.npmrc`** sets `auto-install-peers=false`. Don't remove it. Don't run `npm install` in this directory unless you've intentionally cleared the .npmrc — npm 7+ will otherwise install full copies of `next-auth` / `react` / `framer-motion` into our `node_modules`, and the deck will end up with two instances of every peer.

2. **The host deck's `next.config.js`** sets `webpack: (config) => { config.resolve.symlinks = false; }`. This makes Webpack resolve our peers from the deck's `node_modules` instead of our (real, non-symlinked) directory.

3. **The host deck's `tsconfig.json`** sets `"preserveSymlinks": true`. Same fix for TypeScript's resolver — without it, build's typecheck fails because tsc dereferences the symlink and walks our real path looking for `node_modules`.

If a new deck repo gets created from the template, all three must be present. The template carries (2) and (3); this package carries (1). Remove any one and the bug resurfaces.
