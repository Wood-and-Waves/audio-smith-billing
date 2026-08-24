# Punch Time Chips Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the punch dialog's native time input + Save with a picker
where tapping a time IS the commit — because the iOS picker's checkmark feels
final and Dan has nearly missed punches tapping it and walking away.

**Architecture:** One client component reshaped (`components/PunchClock.tsx`);
no schema, no lib changes, no server-action changes — `recordPunch` and the
zone math (`wallToInstant`/`instantToWall`/`nearest15`) are used exactly as
they are today.

**Design (agreed with Dan, 2026-08-24).** His reality: punches are usually
entered 15–60 minutes late, sometimes hours late (a noon lunch entered at
9pm), occasionally across midnight. So the picker must make *any* time of day
two taps, not privilege "now":

1. **Quick row** — the three quarter-hours nearest now in the show's zone
   (`now−15 · nearest15(now) · now+15`), one tap to save. Rendered only when
   the dialog's date is today in the show's timezone — on a back-filled past
   day "now" chips are meaningless.
2. **Hour grid** — all 24 hours (`12 AM … 11 PM`), 6 columns on `sm:`, 4 on
   phones. Tapping an hour reveals that hour's four quarter chips
   (`12:00 · 12:15 · 12:30 · 12:45`) directly beneath the grid; the chosen
   hour stays highlighted and tapping a different hour just swaps the quarter
   row — no dead ends, no back button.
3. **Tapping any time chip saves immediately** — quick row and quarter chips
   alike call `save()` with that wall time. Nothing renders after the tap but
   the pending state. There is NO Save button on this path.
4. **Date field stays** at the top, prefilled with the row's date, for the
   overnight out — editing it then tapping a time commits both.
5. **"Exact time…"** link swaps the chip UI for the current native
   `<input type="time">` + Save/Cancel pair — the escape hatch for a 5:07.
6. Cancel = the existing outside-tap and Escape; keep the dialog's Enter
   handler only in exact-time mode (chips commit themselves).

## Global Constraints

- Branch `punch-picker` (off the now-live `main`). No migration; ship =
  review → merge → push.
- Zone correctness is the money risk here: every chip's label and its saved
  value must be the SHOW's zone, not the device's — build the quick row from
  `instantToWall(new Date().toISOString(), timezone)` and commit through the
  existing `wallToInstant(atDate, time, timezone)`. The zone note ("Orlando
  time") must be visible BEFORE any chip is tapped, since chips commit
  instantly — move it above the chips.
- A mis-tap must be recoverable: the recorded tile's × already covers it;
  don't add confirmation anywhere.
- `locked`/`pending` disable every chip. Errors render in-dialog as today.
- Accessibility: chips are `<button>`s with labels like
  `Save Lunch In at 12:15 PM`; the hour grid announces expansion state
  (`aria-expanded` on the selected hour or equivalent).
- Theme tokens only. Keep the dialog's existing shell, sizing and idioms.
- Gates: `npm test` (778 pass), cold `npx tsc --noEmit`, `npm run build`.

---

## Task 1: The chip picker

**Files:** Modify `components/PunchClock.tsx` only.

- [ ] Reshape the dialog per the design above. `save()` becomes
  `save(time: string)` taking the wall time from the tapped chip (exact-time
  mode passes the input's value); `atTime` state remains only for exact-time
  mode.
- [ ] Quick row: compute from `nearest15` on the zone-now, minus/plus 15
  minutes (pure string math on `HH:MM`; watch the midnight wrap — `00:00−15`
  is `23:45` *yesterday*, so either wrap the label correctly or drop a chip
  that crosses the date boundary rather than save it against the wrong day).
- [ ] Hour labels via `friendlyTime(\`\${h}:00\`)`-style formatting or a
  local 12-hour formatter consistent with the app's `h:mm AM/PM` voice.
- [ ] Default the hour grid's revealed hour to the zone-now hour when the
  date is today (so the common late-punch is visible without a grid tap),
  and to no hour on a past day.
- [ ] Browser-verify on the dev sandbox (preview tool, never `npm run dev`
  in Bash; stop it before gates): a quick-row tap saves in one gesture; a
  9pm entry of a noon lunch is hour-tap + quarter-tap; an overnight out
  (edit date, tap chip) stores the right instant — check the saved tile's
  rendered time; exact-time mode still saves a 5:07; Escape and outside-tap
  still cancel; a locked day disables everything. Verify one out-of-zone
  case: a show whose timezone ≠ Chicago shows zone-correct chips.
- [ ] Gates, then commit.

## Task 2: Review + ship

- [ ] Task review (fresh reviewer): zone math on every path, the midnight
  wrap, no path that saves without an explicit time tap, a11y, and that
  `recordPunch`/`deletePunch` calls are unchanged.
- [ ] Controller browser pass, merge to `main`, push, prod smoke (auth wall:
  status checks only), tell Dan.
