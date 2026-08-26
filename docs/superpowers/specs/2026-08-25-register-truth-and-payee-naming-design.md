# The register tells the truth: cleared rows inline, real pending, payee naming

Dan, 2026-08-25, after importing his August statement: *"The transactions say
'Pending' but they are not pending. They are cleared... In YNAB 'pending' is a
not cleared transaction. What is meant by 'pending' here?"* And, on autofill:
*"My YNAB new Uber Eats was a 'Meals and Entertainment' before so it auto
assigned it."*

## What we established first (evidence, not assumption)

- **Two independent axes exist in the data**: `cleared` (the bank's state) and
  `entered_at` (whether Dan has reviewed the row). Wave C hung the register's
  top section on the SECOND one and labelled it "Pending" — YNAB's word for
  the FIRST. Every row in that section carries a green cleared badge, which is
  why it reads as nonsense.
- The word was literally taken from the right place: a comment in
  `MoneyRegister.tsx` records that the uncleared group was *"renamed from
  'Pending' now that Wave C gives that word its own, different meaning."*
- **All 332 prod rows are `cleared`.** Zero uncleared, zero reconciled.
- **A file import can never carry a pending transaction.** QFX/QBO/OFX are one
  format (byte-identical bar an `<INTU.BID>` tag) and `<BANKTRANLIST>` requires
  `DTPOSTED`. Chase's CSV *does* carry them (empty `Balance` column; verified —
  7 rows summing to exactly `AVAILBAL − LEDGERBAL` = $1,725.91) but has no
  transaction id, so Dan ruled it out: *"I don't want to do it without ID's."*
  Itemized pending needs a live connection — filed in BACKLOG.
- **Payee memory already exists and already runs on import**, keyed on
  `kind:normalizedPayee`. It fired zero times because it matches the payee
  string EXACTLY: his books hold `Starbucks` (18 rows, categorized) while Chase
  sent `STARBUCKS 8007827282 800-782-728`. Same for `Walmart` vs
  `WAL-MART #5023 NATIONAL CITY CA`. The mechanism is sound; the matching is
  too literal.

## Dan's decisions

1. **Imported rows count in the budget immediately.** `entered_at` stops being
   an accounting gate and becomes a review marker only.
2. **Payee naming suggests, he confirms once.** No silent automatic merging —
   his own Grand Hyatt vs Hyatt Regency is exactly why.
3. **A renamed payee replaces Chase's text entirely.** (Traceability survives:
   every imported row still stores the bank's `FITID` in `import_id`.)
4. **No chip.** An unreviewed row is marked **bold + a dot in the left rail**.
5. **"Pending" returns to meaning uncleared**, as its own group when non-empty.

## Part 1 — the register stops lying

**Structure.** The pending-by-approval section is deleted. Every row renders in
the ledger in date order, whatever its `entered_at`. The uncleared group
returns to the top under the heading **Pending**, rendered only when it has
rows (it will be empty for Dan today, by construction).

**The unreviewed marker.** `entered_at === null` renders the row's text bold
and puts a small dot in the left rail beside the receipt control. Both vanish
the moment the row is entered. **The `opacity-70` fade is removed** — that is
the root cause of his dropdown bug (see Part 3) and it must never return to a
container that holds a popover.

**The actions keep his words.** `Enter Now` stays per row (rendered only on an
unreviewed row); `Enter All` moves to a slim line above the register reading
`N to review · Enter All`, shown only when N > 0. `Reject` stays on the row —
it is still the only way to discard an imported row it should never have
brought in, and it still tombstones before deleting.

**Entering now moves no money.** It sets `entered_at` and clears the marks.
Nothing else changes, because the row already counted.

## Part 2 — the budget gate is removed

`explodeForCategories` (`lib/ledgerSplits.ts`) currently yields NOTHING for a
pending row; that is what keeps imports out of every category-shaped consumer
(budget activity and RTA, P&L, spend-by-category, monthly reports, the CPA
export, the forecast's ledger reads, and `scripts/parity/ynab-live.mjs`).
That exclusion is deleted, in the one helper, so every consumer changes
together and none can drift.

`pendingBlocksReconcile` and the reconcile refusal are also removed: an
unreviewed row is now ordinary money, and refusing to reconcile over it no
longer has a rationale.

**The predicted effect on his live books, computed before building:** his 8
unreviewed rows are 6 uncategorized totalling −$147.85 and 2 Temporary
Transfer rows netting exactly $0.00. So **every category's parity must stay
exactly where it is, and Ready to Assign must move from $1.01 to −$146.84.**
That figure is the ship gate — anything else means something is wrong and the
wave does not ship.

Dan accepted the known consequence that six of those rows are still *pending*
in YNAB (which does not count pending in its budget), so the two books will
disagree by $147.85 for the few days until Chase posts them.

## Part 3 — the dropdown bug, root cause

`opacity-70` on the pending row wrapper (`MoneyRegister.tsx:1800` desktop,
`:1962` phone) creates a CSS **stacking context**. The `CategoryPicker`
dropdown renders inside it, so it (a) inherits the fade — which is why the
rows behind bleed through the open menu — and (b) cannot rise above the sticky
header's `z-10` despite its own `z-30`, because z-index only competes within a
stacking context. One property, both symptoms. Verified: no transform, filter,
isolation or other stacking-context creator exists anywhere in that tree.

Removing the fade (Part 1) IS the fix. No z-index is changed.

## Part 4 — payee naming

**The alias table** (migration 0048, additive):
`ledger_payee_aliases (owner_id, raw_payee, display_name)`, unique on
`(owner_id, raw_payee)`, where `raw_payee` is stored already normalized
(`normalizePayee`: trimmed, whitespace-collapsed, lowercased) so a lookup can
never miss on spacing or case.

**On import**, each NEW row's raw payee is looked up; a hit replaces the payee
before insert. Payee memory then runs on the RENAMED payee, so aliasing
Starbucks once makes his existing 18 categorized Starbucks rows teach the
category from the very next import. Adopted rows are untouched — they already
carry his own name.

**The suggestion** is a pure function, `suggestDisplayName(raw, knownPayees)`:
it prefers the LONGEST known payee whose normalized, punctuation-stripped form
appears inside the raw string (so `STARBUCKS 8007827282 …` suggests his
existing `Starbucks`); failing that it falls back to a cleaned form of the raw
string (leading words, title-cased, trailing store/phone/state noise dropped).
It is a suggestion only — a wrong one costs one correction and is never
repeated, because the alias is keyed on the exact raw string.

**The UI** lives in the row's existing edit mode: when the payee has no alias
and a suggestion differs from it, a chip reads `Use "Starbucks"`. Clicking
fills the payee field. A checkbox, **on by default**, reads
`Remember this name for future imports`. Saving with it ticked writes the
alias and renames every other row sharing that exact raw payee, so one
confirmation cleans up the past as well as the future.

## Testing

Pure libs carry the logic and the proof (`node --test`): the suggestion
function (existing-payee match wins over cleanup; longest match wins;
punctuation and case insensitivity; no known payee → cleaned fallback; a raw
string that matches nothing returns something sane), and the alias
normalization round-trip. `explodeForCategories`' pending tests invert —
a pending row must now yield its line like any other.

Then the gates (`npm test`, cold `tsc --noEmit`, `npm run build`), a browser
walkthrough on the dev sandbox, and **`npm run parity` as the ship gate**
against the predicted figures above.

## Out of scope (deliberate)

- Importing Chase's CSV, and itemized pending generally — needs a live bank
  connection (BACKLOG).
- Taking category clues from invoice expenses — Dan asked; it is already
  filed and blocked on his CPA reconciling the three charts of accounts.
- Automatic payee merging with no confirmation (his decision 2).
- Any change to reconcile beyond removing the now-baseless pending refusal.
