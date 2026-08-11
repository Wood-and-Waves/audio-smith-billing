# Follow the Device's Light/Dark Mode — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The app follows the device's light/dark setting. No toggle, no stored preference.

**Architecture:** Every colour already resolves through a CSS variable mapped into Tailwind by
`@theme inline`, so this is a palette swap in one file plus a `themeColor` change — components are
not touched. The dark palette stays in `:root` as the default; a `@media (prefers-color-scheme:
light)` block overrides it. Because nothing is JavaScript-controlled, the correct theme applies at
first paint and there is no flash to defend against.

**Tech Stack:** Tailwind v4 (CSS-first, no config file), Next.js 16 App Router.

## Two decisions, already made

**No manual toggle.** Follow the device silently. This is what removes `localStorage`, the
`data-theme` attribute, the pre-paint script, and the toggle component — all of which CrewTracker
needs and this app does not.

**The invoice document never changes.** It renders identically in both themes because it is a
preview of what a client receives. `components/InvoiceDocument.tsx` uses `--paper` /`--paper-ink` /
`--paper-line` plus sixteen `text-neutral-500`/`-600` classes; all of those are correct on white
and must be left exactly as they are. Do not "fix" them into tokens — they are deliberately
absolute. In light mode the document will sit on a light ground, so it needs a border to still read
as a separate sheet (Task 2).

## Global Constraints

- Colour changes happen in `app/globals.css` only. No component may gain a theme conditional.
- **The invoice document is invariant.** No change to `components/InvoiceDocument.tsx`, and no
  change to the `--paper-*` tokens, which stay absolute in both themes.
- Every foreground/background pair must meet **WCAG AA: 4.5:1** for body text, 3:1 for large text
  and UI borders. Verified figures are given below — recompute anything you alter.
- Do not change the dark theme's appearance. It is the designed default and is already in use.
- `npm test` is 41/41 and `npm run build` must stay clean.
- Commit after every task.

## The light palette, with measured contrast

Values are drawn from theaudiosmith.com, which is already a light design in this brand, then
adjusted where the site's usage does not transfer. Contrast computed against the light `--bg`
`#f1f5f9` unless noted.

| Token | Dark (unchanged) | Light | Contrast on light bg |
|---|---|---|---|
| `--bg` | `#121212` | `#f1f5f9` | — (the site's `--bg-light`) |
| `--surface` | `#1a202c` | `#ffffff` | — (the site's white cards) |
| `--surface-2` | `#232c3b` | `#e2e8f0` | — |
| `--ink` | `#f8fafc` | `#121212` | **16.4:1** |
| `--muted` | `#94a3b8` | `#475569` | **6.9:1** (`#64748b` measures 4.35 and fails) |
| `--line` | `#2a3441` | `#cbd5e1` | — (the site's `--line`) |
| `--accent` | `#f59e0b` | `#b45309` | **4.8:1** (`#f59e0b` measures **2.15** and fails badly) |
| `--accent-ink` | `#121212` | `#ffffff` | **4.8:1** on the accent fill |
| `--accent-wash` | `rgba(245,158,11,.18)` | `rgba(180,83,9,.14)` | focus ring tint only |
| `--danger` | `#ef4444` | `#dc2626` | **4.9:1** (`#ef4444` measures 3.76 and fails) |
| `--good` | `#10b981` | `#047857` | **5.5:1** (`#10b981` measures 2.56 and fails) |
| `--paper*` | absolute | **unchanged** | the invoice never flips |

The accent is the important one. `#f59e0b` works on charcoal and is unreadable on white — which is
why theaudiosmith.com only ever uses amber *on* dark, or as a solid fill with dark text on top.
Flipping `--accent-ink` to white in light mode keeps buttons legible without any component change.

---

### Task 1: The light palette

**Files:**
- Modify: `app/globals.css`
- Modify: `app/layout.tsx` — `themeColor`

- [ ] **Step 1: Declare that both schemes are supported**

In `app/globals.css`, add to the `:root` block. Without this, native form controls, scrollbars and
the browser's own UI stay dark-styled in light mode — the app looks right and the widgets do not.

```css
  /* Tells the browser both themes are real, so it themes native controls,
     scrollbars and form widgets to match rather than assuming one. */
  color-scheme: dark light;
```

- [ ] **Step 2: Add the light override**

Append after the existing `:root` block, before `@theme inline`. Dark stays the default in
`:root`; this overrides it when the device asks for light.

```css
/*
  Light mode. The dark palette above is the designed default and stays in
  :root; this block overrides it when the device asks for light.

  These are NOT the dark values inverted. Amber #f59e0b measures 2.15:1 on
  white — unreadable — which is why theaudiosmith.com only ever puts amber on
  dark, or uses it as a fill with dark text on top. Every value here was
  measured against WCAG AA (4.5:1 body text) and the figure is in the comment.

  --paper-* are deliberately absent: an invoice is a document a client
  receives, and it looks the same whatever theme the app is wearing.
*/
@media (prefers-color-scheme: light) {
  :root {
    --bg: #f1f5f9;          /* the site's --bg-light */
    --surface: #ffffff;     /* the site's white cards */
    --surface-2: #e2e8f0;
    --ink: #121212;         /* 16.4:1 on --bg */
    --muted: #475569;       /* 6.9:1 — #64748b measures 4.35 and fails */
    --line: #cbd5e1;        /* the site's --line */

    --accent: #b45309;      /* 4.8:1 — #f59e0b measures 2.15 and fails */
    --accent-ink: #ffffff;  /* 4.8:1 on the accent fill */
    --accent-wash: rgba(180, 83, 9, 0.14);

    --danger: #dc2626;      /* 4.9:1 — #ef4444 measures 3.76 */
    --good: #047857;        /* 5.5:1 — #10b981 measures 2.56 */
  }
}
```

- [ ] **Step 3: Make the browser chrome colour follow too**

`app/layout.tsx` hardcodes `themeColor: '#121212'`, which tints the browser UI on mobile and would
stay charcoal against a light app. Replace it with the media-aware form:

```ts
export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f1f5f9' },
    { media: '(prefers-color-scheme: dark)', color: '#121212' },
  ],
}
```

Read the file first — keep whatever else the existing `viewport` or `metadata` export declares.

- [ ] **Step 4: Verify and commit**

```bash
npm run build   # must compile clean
npm test        # 41/41
```

```bash
git add app/globals.css app/layout.tsx
git commit -m "Follow the device's light/dark setting."
```

---

### Task 2: Make the invoice read as paper in light mode

**Files:**
- Modify: `components/InvoiceDocument.tsx` — the outer wrapper only

In dark mode the white document stands out against charcoal on its own. In light mode it sits on
`#f1f5f9`, which is close enough to white that the sheet loses its edge and stops looking like a
document.

- [ ] **Step 1: Give the sheet an edge that only shows when it needs one**

The component's outer `<article>` currently carries `shadow-lg`. Add a hairline border so the sheet
is defined against a light ground, without altering how it looks on dark.

Use the existing `--paper-line` token — **not** `--line`, which flips with the theme. The paper's
own border belongs to the paper.

```tsx
<article className="bg-paper text-paper-ink rounded-card overflow-hidden shadow-lg border border-paper-line">
```

Change nothing else in this file. The sixteen `text-neutral-500`/`-600` classes are correct on
white and must stay.

- [ ] **Step 2: Verify and commit**

```bash
npm run build
npm test
```

```bash
git add components/InvoiceDocument.tsx
git commit -m "Keep the invoice reading as a sheet of paper on a light ground."
```

---

### Task 3: Verify both themes on every screen

Colour bugs do not fail a test suite. This task is looking at it.

- [ ] **Step 1: Start the app**

```bash
npm run dev -- --port 3100
```

Authentication requires the dev-login secret in a URL, which a security classifier blocks. If you
hit that, do NOT work around it — report it, and fall back to verifying `/login`, which needs no
session and exercises the background, surface, ink, accent fill and focus ring together.

- [ ] **Step 2: Look at every screen in both themes**

Switch the OS appearance (or emulate `prefers-color-scheme` in devtools) and check each of:
`/login`, `/invoices`, an invoice detail, `/invoices/new`, `/shows`, a show detail, `/shows/new`,
`/clients`, a client editor, `/settings`.

At **1280px and 375px**. For each, confirm:
- No text that disappears into its background, and no element that vanishes entirely.
- The status colours still read as status — amber for due, red for overdue, muted for paid.
- Focus rings are visible on both grounds. Tab through a form to check.
- Native controls — date inputs, selects, checkboxes, scrollbars — match the theme. If any are
  still dark on light, `color-scheme` in Task 1 Step 1 did not take.
- **The invoice document looks identical in both themes.** This is the acceptance test for the
  whole change: it is a preview of what a client receives, so it must not move.

- [ ] **Step 3: Report and commit any fixes**

Record what you checked and what you saw, screen by screen. If a colour needs adjusting, change it
in `app/globals.css` only, recompute its contrast ratio, and put the figure in the comment beside
it. No component may gain a theme conditional.

---

## Self-review notes

| Requirement | Task |
|---|---|
| Follows the device | 1 |
| No toggle, no stored preference | (by omission — nothing to build) |
| No flash on load | (free — a media query applies at first paint) |
| Native controls follow too | 1, Step 1 |
| Browser chrome colour follows | 1, Step 3 |
| Invoice looks the same as it is sent | 2, and the acceptance test in 3 |
| AA contrast on the light ground | palette table, verified per value |

**Deliberately not done:** no manual override, no `data-theme`, no theme script, no toggle
component. Adding a toggle later is easy from here — it is an attribute selector duplicating the
same block — but it is not wanted now and would bring back the flash-on-load problem this design
avoids entirely.
