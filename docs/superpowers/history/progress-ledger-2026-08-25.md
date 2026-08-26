# Ledger — ledger-spine plan (docs/superpowers/plans/2026-08-18-ledger-spine.md)
Branch: ledger. Migration 0027 applied to DEV (ddeutgidrqzfsqxnsxub) and committed.
Model tiering per Dan: haiku = exact-code tasks, sonnet = logic/UI/reviews, opus = final only.

Task 1 (controller): complete — migration 0027 written, committed, applied to dev.
Task 2: complete (7d3293d..d573ff8, review clean — byte-identical transcription; haiku impl,
  sonnet review). 349/349, tsc/build clean.
Task 3: complete (d573ff8..aa483d8 + fixes d9246d1, review found 3 Important — ALL FIXED)
  OFX parser + planImport. Fixes (TDD, red-then-green): zero-amount rows -> skipped[]
  (would've violated DB check); LEDGERBAL scoped (AVAILBAL could win); GEN ids max-based
  (count-proxy gap => silent duplicate-drop of REAL transactions). 366/366, tsc/build
  clean. ImportPlan gained skipped; plan doc's importOfx signature amended.
  Minor accepted: comma-decimal TRNAMT mis-parse (out-of-spec input, documented).
Task 4: complete (99bdf76 + fix 1b42ebc, review 2 Critical + 1 Important + 2 Minor)
  Money server actions. CRITICALS FIXED: Supabase 1000-row select cap silently truncated
  reconcile balances AND import dedupe — now paged via fetchAllLedgerTransactions helper
  (.range chunks, stable order). Minor fixed: authorize account before parseOfx.
  ACCEPTED (parity with repo patterns): reconcile's 4 writes non-transactional (matches
  addExpense style; future RPC could harden); sequential import awaits; future index
  (account_id, created_at, id) if an account grows huge. 366/366, tsc/build clean.
Task 5: complete (1b42ebc..bbe6861, review clean, zero fixes)
  /money register + nav. Paged full-set balances verified; sign conventions traced clean
  (add negates once; update passes signed through); owner_pay nulls category on submit.
  Minor accepted: blank opening balance = $0 (matches action contract). 366/366.
Task 6: complete (bbe6861..172fc43 + fix 0fec050, review 2 Important — both FIXED)
  Import/reconcile panels + category editor. Fixed: blank statement balance no longer a
  phantom $0 (parseUSD('') trap); reconcileAccount now returns a structured
  { mismatch, diffCents, message } variant — substring coupling deleted. Accepted: no
  new-group control (per spec); CreateAccountCard blank-opening=$0 left (legit $0 case,
  final review to adjudicate). 366/366, tsc/build clean.
ALL BUILD TASKS COMPLETE — final whole-branch review (opus) next.
FINAL review (opus): 2 Critical + 7 Important + minors. FIX WAVE c7fb8bf + migration 0028
  (unique category names, applied to dev): C1 idempotent GEN re-import (occurrence-position
  classify, maxN+ assignment; idempotence test added); C2 first-load crash (revalidatePath
  removed from ensureDefaultCategories, 23505-tolerant seed); I1/I2 malformed OFX -> clean
  throw pre-write; I3 in-batch FITID dedupe + match-loop 23505; I5 setTransactionCategory
  (works on reconciled rows; picker updated). Re-review: ALL VERIFIED, ship for sandbox.
  370/370, tsc/build clean.
PRE-PROD HARDENING LIST (before the prod ship gate):
  - I4: reconcileAccount 4 writes non-transactional -> RPC (precedent: allocate_invoice_number)
  - Extract validateTxnShape to a pure tested lib
  - updated_at triggers for ledger_accounts/ledger_transactions (migration)
  - Remove or wire dead updateLedgerTransaction + updateLedgerAccount
  - Prefill reconcile statement balance from parseOfx's ledgerBalanceCents (nice UX)
  - I7 note: reconcile has no as-of-date scoping (YNAB model); revisit if it bites
  - Index (account_id, created_at, id) if accounts grow large
SANDBOX READY on branch ledger. Prod gate: migrate 0027+0028 to prod BEFORE deploying.
  - "Mark as owner pay" control for imported rows (imports arrive as expense-kind; the
    four TRANSFER TO PERSONAL rows in Dan's test file demonstrate the need)
Sandbox reset 2026-08-18: ledger tables wiped (categories kept); Dan testing with
business-checking-may-aug-2026.ofx (28 txns, opening 7342.98 @ 2026-05-01, reconciles
to 15820.33 @ 2026-08-15).

# Wave A — register-polish plan (docs/superpowers/plans/2026-08-18-register-polish.md)
Branch: ledger (continues). Dan approved: polish then dashboard. Opus final deferred to
end of wave B (covers A+B before any ship gate).
Wave A Task 1: complete (53d2ee9, controller-verified byte-identical to plan; 375/375).
Wave A Task 2: complete (4ad61ab + blank-payee guard, review ship w/ 1 latent — FIXED)
  importOfx auto-categorizes via payee memory + returns statementBalanceCents/
  autoCategorized; setTransactionCategory(applyToSamePayee) sweep. Accepted: hidden
  categories can be auto-applied (consistent w/ app's hidden-category tolerance).
  375/375, tsc clean.
Wave A Task 3: complete (142bd0a, review clean — sign round-trip traced correct, blank-amount
  guarded, apply-to-more + prefill verified). WAVE A COMPLETE on branch ledger.
  Accepted limitations (disclosed, per spec): apply-to-more counts only loaded 200 rows.
Next: Dan sandbox walkthrough of wave A -> wave B (dashboard) on his go. Opus whole-branch
review still deferred to end of wave B (pre-ship).

# Wave B — money-reports plan (docs/superpowers/plans/2026-08-18-money-reports.md)
Wave B Task 1: complete (896595f, controller-verified byte-identical; 380/380).
Wave B Task 2: complete (8d4da10 + year-label fix, gates green). /money/reports live.
WAVE B COMPLETE. Capstone opus whole-branch review (spine + A + B vs main) next.
CAPSTONE (opus, whole branch): sandbox-shipworthy; 5 Important + minors. FIX WAVE 22b7d77:
  I1 kind-aware payee memory (memoryKey kind:payee; sweep matches source kind);
  I2 import adoption preserves reconciled; I3 deductible editable (CategoryEditor toggle,
  saveCategory both branches); I4 apply-prompt hoisted above the list (survives filtered
  refresh); I5 reconcile date-scoped to reconciledOn + adjustment left correctable;
  M4 friendly duplicate-name error. 385/385, tsc/build clean.
REMAINING PRE-PROD PUNCHLIST (capstone, in order): reconcile RPC (atomicity);
  validateTxnShape -> pure tested lib; updated_at triggers migration; remove/wire
  updateLedgerAccount; honest apply-to-more count; date sanity bounds (M6); transfer kind
  in edit list or hide (M3); hidden category shown as "(hidden)" in edit picker (M2);
  (account_id, created_at, id) index if large; mark-as-owner-pay quick control;
  fix 6 doc/comment contradictions (incl. 0027 deductible comment, spec ship-gate line
  must say 0027+0028, spec importOfx counts, NAME-vs-PAYEE note, plan GEN description).
  SHIP ORDER: migrate prod 0027 THEN 0028 BEFORE deploying; verify /money renders +
  PUBLIC_PREFIXES still excludes /money.
BRANCH ledger COMPLETE THROUGH WAVE B — Dan's sandbox walkthrough next.

# Punchlist wave (2026-08-19) — COMPLETE
Migration 0029 (atomic reconcile RPC, updated_at triggers, paging index, deductible
comment) applied to DEV. ece9749: lib/ledgerRules (validateTxnShape + isSaneLedgerDate
1990-2100, 15 tests), date bounds at every entry point, reconcileAccount -> RPC,
updateLedgerAccount removed. a838003 + doc fix: honest at-least-N apply count, Edit
hidden on transfer rows, hidden category "(hidden)" option, spec/plan corrections
(ship gate = 0027+0028+0029 in order). 400/400, tsc/build clean.
DEFERRED BY CHOICE: mark-as-owner-pay quick control (Edit covers it); delete allowed on
transfer rows (legitimate); ledgerBalanceCents-driven reconcile prefill already done.
STATUS: pre-prod punchlist WORKED. Ship gate awaits Dan's real-data verdict.

# Wave C — business-envelopes plan (docs/superpowers/plans/2026-08-19-business-envelopes.md)
Dan: full envelopes, manual funding v1 (auto-feed waits for the bridge). Migration 0030
applied to DEV. Ship gate now = 0027+0028+0029+0030 in order.
Task 1 (controller): complete.
Wave C Task 2: complete (99d73f3, controller-verified byte-identical; 405/405 after
  vocabulary swap 724d174 — DEFAULT_CATEGORIES = Dan's real YNAB chart from his
  2026-08-19 reflect export; envelope seeds = his Savings funds Taxes/Tax Prep/Retained
  Earnings; Taxes seeded non-deductible. Dev DB keeps old chart (his call to reseed);
  prod seeds the new one. Backlog noted: income-by-payee report (his per-client model).
Wave C Tasks 3+4: complete (01d925a actions, 471a0ee budget page, combined review 2
  Important — FIXED in a6b12ce: hidden envelopes stay reachable via "Hidden (N)"
  disclosure (all envelopes loaded, categories-editor precedent), unhide always allowed,
  hide rule server-enforced (balance must be 0). Minor accepted: move-line field order.
WAVE C COMPLETE: /money/budget live on dev — envelopes seeded from Dan's YNAB Savings
  funds (Taxes/Tax Prep/Retained Earnings), immutable move ledger, Available-to-allocate,
  show-card set-aside links to the Taxes envelope. 405/405, tsc/build clean.
SHIP GATE now = migrations 0027+0028+0029+0030 to prod IN ORDER before deploying.

# SHIPPED TO PROD (2026-08-19): migrations 0027-0030 applied+verified on prod, Money
merged ca809a4..ce37894, deployed. Backfill tooling f3360ec (lib/ynabRegister +
36 tests + scripts/import/ynab-backfill.mjs, dry-run default, manual/null-import_id
inserts so future OFX adopts). DEV ledger wiped for rehearsal (reseeds Dan's chart on
next visit). AWAITING DAN: Register CSV export, Jan 1 balance, prod first-visit account.


# WAVE: receipt-corners (2026-08-19) — corner detection + flatten + adjuster
Plan: docs/superpowers/plans/2026-08-19-receipt-corners.md (branch receipt-corners off 2663a07)
Tasks: 1 receiptQuad lib | 2 receiptWarp lib | 3 receiptCorners lib | 4 applyContrastStretch |
5 enhance() refactor+batch | 6 CornerAdjuster+single confirm | 7 fix-later action+flow | 8 final review
Task 1: complete (commits 79f004a..59fd570, review clean; minor: MIN_USABLE_CORNER_GAP extra export kept)
Task 2: complete (5cc35e9, TDD — math validated by hand/numerically before writing tests,
  14 new tests). Heckbert closed-form rectToQuad (affine branch when opposite sides are
  parallel, g=h=0; det<1e-9 -> null on collinear tr/br/bl) + mapPoint, both branches exact
  to 1e-9 on hand-built quads. warpOutputSize averages opposite edges via Math.hypot then
  reuses scaleToFit (3-4-5 triangle quad for clean hand values). bilinearSample exact on
  integers, hand-computed midpoints, edge-clamped. warpGray: ramp test proves bilinear is
  exact on linear fields (maxDiff 0 in validation); identity-quad test deliberately uses a
  GENTLE 2D gradient (slope 1 both axes) because the +0.5 pixel-center convention bounds
  subpixel error to ~0.5px per axis — a steep/chaotic source would NOT reproduce within
  +/-1 (verified: a chaotic test source gave maxDiff 162, caught before writing the real
  test); checkerboard test buckets by cell parity with a 5px border margin, asserts block
  MEANS (255/0 exactly in validation). Mutation-checked: removing the +0.5 offset breaks
  the ramp+identity tests as expected. 477/477, tsc clean.
Task 2: complete (commits 59fd570..118a791, review approved; controller fix: inlined homography in warpGray hot loop)
Task 3: complete (6b28785, lib/receiptCorners.ts + 23 tests, TDD). blur->Otsu->largest-
  bright-component->boundary hull->reduceHull(24)->exhaustive maxAreaQuad(C(24,4));
  detection runs on a DETECT_MAX_EDGE=400 downscale, result scaleQuad'd back to input
  coords. Empirically verified (not just derived): a uniform 1px background inset is the
  THINNEST border that still gives Otsu separation, and even that caps the recovered
  quad's area fraction around ~97.5% (3x3-blur corner rounding + max-area-quad fit loss)
  -- so the required "near-full-frame (~99%)" rejection test can't be built as a plain
  inset rectangle; it uses a full-bright frame with small dark notches cut into the
  MIDDLE of each edge (corners stay sharp/untouched -> hull recovers true image corners
  -> quad area 99.5% -> quadSane's MAX_AREA_FRACTION gate rejects it, confirmed via
  direct pipeline introspection before locking in the test). Self-review checks done:
  boundaryPoints' `onBorder` clause (separate test: receipt quad clipped by the right
  frame edge still hulls to a sane quad, tr/br.x pinned to width-1..width); reduceHull
  recomputes all triangle areas fresh from current state each removal (no staleness
  possible by construction); noise amplitude (+/-8) vs BG/RECEIPT gap (190) leaves no
  room to flip Otsu classes. 500/500 (repo-wide), cold tsc clean. Perf: ~4ms/call on a
  400x300 synthetic (well under budget).
Task 3: complete (commits 118a791..6b28785, review approved; MINOR for final review: fill-ratio mixes pixel-count vs shoelace area, biases high for small quads — comment/backlog note)
Task 4: complete (commits 6b28785..32fca9d, haiku transcription, controller byte-verified)
Task 5: complete (commit c1f525a, ExpenseLog.tsx only). Added WARP_SOURCE_MAX_EDGE=2400,
  grayFromBitmap (scaleToFit math parameterized by maxEdge, same luma expr/rounding
  treatment as enhance()'s existing loop), grayToJpeg, async detectCorners (photos only,
  throws propagate). enhance(file, quadNorm?) tri-state: undefined auto-detects on THIS
  bitmap's own DETECT_MAX_EDGE gray (no second decode); null skips warp; a Quad is used
  only if quadUsable, else treated as null. Quad path: gray at WARP_SOURCE_MAX_EDGE ->
  scaleQuad+clampQuad denormalize on THAT plane's own w/h (verified detectReceiptQuad
  already rescales its result back to its gray argument's coord space before returning,
  so dividing by that same gray's w/h normalizes correctly — no detect-plane/warp-plane
  mixup) -> warpOutputSize -> warpGray -> null falls through to no-quad path ->
  applyContrastStretch -> grayToJpeg. No-quad path and PDF branch are today's exact code,
  diffed to confirm: only change is bitmap.close() moved into a single finally (was
  inline, and would have double-closed against the new quad-path early return).
  uploadReceiptPair threaded with optional quadNorm; both call sites (onPickFile,
  runBatchRow) pass nothing, unchanged, so batch stays auto-detect. 502/502, cold tsc
  clean, build clean.
Task 5: complete (commits 32fca9d..c1f525a, review approved, byte-identity of fallback diff-verified)
Task 6: complete (commit ca2b6f0). New components/CornerAdjuster.tsx (shared dialog: PunchClock's
  overlay idiom verbatim; object-contain letterbox box tracked in state via naturalWidth/Height vs
  wrapper getBoundingClientRect, refreshed on img onLoad + ResizeObserver; svg has NO viewBox so its
  user units equal its own rendered CSS px 1:1 -- keeps r=10 handles true circles; pointer events
  convert clientX/Y through a FRESH wrapper rect at event time, not the cached box, so scrolling
  can't skew a drag; setPointerCapture on down, released on both pointerup AND pointercancel
  (mobile Safari fires cancel when a drag turns into a scroll); invisible r=24 hit circle carries
  the handlers, visible r=10 dot is pointer-events:none so it doesn't shadow the hit target;
  quadUsable gates Confirm + danger stroke; orderQuad canonicalizes before onConfirm, `?? quad`
  fallback commented as unreachable given quadUsable's own gap floor). ExpenseLog.tsx: split
  onPickFile at the isPdf branch -- PDFs call beginUpload(f, null, token) straight through (no
  adjuster); photos run detectCorners, bail if superseded, then setPendingAdjust with the detected
  quad or a new INSET_QUAD (12%) default. beginUpload is the old onPickFile body verbatim, quadNorm
  threaded to uploadReceiptPair. New module const INSET_QUAD, new pendingAdjust state (file/url/
  quad/token). Object URL revoked on all four exits: onConfirm, onCancel (clear only, no setError
  -- nothing was uploaded), onPickFile's supersession cleanup, and a ref+unmount-only effect for
  ExpenseLog itself unmounting mid-adjust (client-side nav away) -- traced as the one exit none of
  the other three reach; harmless double-revoke not a concern (spec no-ops on an already-revoked
  URL) so it wasn't a reason to prefer one mechanism over the other. Batch path (onPickFiles/
  runBatch/runBatchRow) untouched -- diff-confirmed. Letterbox math hand-traced for both a landscape
  photo capped by max-height (pillarboxed) and a portrait photo capped by max-height (also
  pillarboxed, different axis logic) before trusting it; both reduce to the standard
  scale=min(boxW/contentW, boxH/contentH) object-contain formula. 502/502, cold tsc clean, build
  clean.
Task 6: complete (commits c1f525a..f66f2e9, review found Escape-focus defect, controller-fixed f66f2e9; minors for final review: no focus trap/restore)
Task 7: complete (commits 9bad3d0..dfacd9b, review approved incl. security trace)
Task 8: final review READY FOR MERGE; fixes 58a9f83 (dialog-stacking guard, dead export). Awaiting Dan sandbox verification before merge (merge = prod deploy).
SHIPPED (2026-08-20): receipt-corners merged 2663a07..fef3078, pushed, Vercel deploying. Delta review MERGE verdict, 2 LOW fixed pre-merge (viewer focus guard, CSS comment). BACKLOG corner entry retired. No migrations. Extras shipped same branch: loupe, receipt lightbox, single-add dup warning, punch tile grid, invoice-row show titles, mobile polish, travel-checkbox removal. Dev-only data seeded (rate cards, work_for backfill) — dev DB only, not prod.
BACKFILL COMPLETE (2026-08-20): YNAB Register backfilled to PROD — 328 txns (Chase Checking, opening 585.75 @ 2026-01-01, ending 6,660.81 verified vs bank), 172 memos, 3 uncleared (Fairmont). Dev rehearsed first, identical numbers. BOM parser fix bdbb683 + register memo display 5fc0fb3 shipped. Remaining for Dan on live app: categorize 6 uncategorized, 3 envelope moves from YNAB fund balances, first reconcile (statement bal 7,252.91 = cleared).


# WAVE: register (2026-08-21) — true register + ledger receipts + theme + punch row
Plan: docs/superpowers/plans/2026-08-21-register.md (branch register off 3b72c07)
Tasks: 1 migration 0031 | 2 balance helpers | 3 capture extraction | 4 ledger receipt actions |
5 page transform | 6 MoneyRegister layout | 7 theme | 8 punch row | 9 backlog | 10 review+ship
SHIP ORDER: 0031 to prod BEFORE merge.
Task 1: complete (0031 applied to dev)
Task 2: complete (d312d51, controller-reviewed, 526 tests)
Task 3: complete (4857c3b, controller byte-diff verified: only export prefixes + subfolder rename)
Task 4: complete (5e79c86) | Task 5: complete (0cce25f) | Task 8+9: complete (8def5c1)
Task 6: complete (34a6674) | Task 7: complete (95da9f7)
Task 10: review complete (opus FIX FIRST -> fixes e1275a3, minors 4-7,10 accepted/backlogged). AWAITING DAN: sandbox look + ship go (0031 prod BEFORE merge).
SHIPPED (2026-08-21): register wave merged 9cf352b..109d17a, 0031 applied to prod FIRST, deployed. 527 tests.
DROPBOX RESOLVED (2026-08-21): new app + creds pushed to Vercel prod, cron-triggered archive verified 2 files. Sensitive env vars pull as <ENCRYPTED> — never diagnose from pulls.

--- BRIDGE WAVE (2026-08-21, branch bridge, base 6abf9d7, plan docs/superpowers/plans/2026-08-21-invoice-expense-bridge.md) ---
Task 1: complete (2406b23, review clean; report typo '7 columns' noted, schema verified byte-identical)
Task 2: complete (03d2217, review clean; 3 minor boundary-test gaps folded into Task 3 dispatch)
Task 3: complete (2dd7737 + boundary tests 5c7e0ee, review clean; remaining minors for final review: expense-side ambiguity mirrors, sum-order id tie-break test)
Task 4: complete (a8acc92, controller byte-verified vs plan)
Task 5: complete (95e0550 + fail-closed fix adeb9f4, review: Important fixed; minor guard-reads-ignore-error idiom noted for final review)
Task 6: complete (ba77f8e + key fix ded850c, review: Important fixed; browser check deferred to Task 9 walkthrough)
Task 7: complete (ed3e318, review clean)
Task 8: complete (72fed25, controller-verified vs plan)
Task 9: docs committed, opus FIX FIRST -> fix wave dee8c13 (9 fail-closed + tokens + 4 guards), re-review CLEAN, 567 tests. Backlog trade-offs recorded. NEXT: browser walkthrough + Dan ship gate (0032 prod BEFORE merge).
Task 9: walkthrough PASSED on dev sandbox (income accept/unlink + guards, Uber group + evidence + dissolve-whole, JD receipt join + lightbox, dismiss persistence, badge counts; test deposit cleaned up, Uber+JD links left in place). AWAITING DAN: ship go (0032 prod FIRST, then merge).
SHIPPED (2026-08-21): bridge wave merged 6abf9d7..2b0be3d, 0032 applied to prod FIRST, pushed. 567 tests. Sandbox walkthrough passed. Prod smoke pending deploy.

--- BRIDGE POLISH (2026-08-21 evening, branch bridge-polish, base 2b0be3d): restore-dismissals UI, payee-agrees badge, sent dates on cards, old-paid candidate rule. Prod links RESET by Dan's direction (15 inv + 3 exp unlinked, dismissals kept) for a fresh re-run after this ships. NO migration needed.
POLISH: A ca15064, B 8aa4da7, opus READY TO MERGE + batch dddd466, 575 tests, dev-verified (chip, dismiss->restore->card returns). Shipping (no migration).

--- CALENDAR WAVE (2026-08-21 night, branch calendar, base 55d265f, plan docs/superpowers/plans/2026-08-21-calendar-flights.md) ---
Cal Task 1: complete (50d371e, controller byte-verified, 0033 on dev)
Cal Tasks 2+3: complete (1d1a97e, c8c8a48; review Approved-no-findings, reviewer executed edges; 606 tests)
Cal Task 4: complete (e6f3bc5) | Cal Task 5: complete (8a8ca65, 404 paths + private-page smoke done)
Cal Task 6: complete (55d3884; nav-width + lookup-live checks deferred to controller walkthrough)
Cal Task 7: docs done, opus FIX FIRST -> fix wave fd7e1c6 (H1 timestamptz->Z + DTEND + 9 more), 611 tests, walkthrough PASSED (grid, today, months, flight dialog error+manual path, detail, feed 200/404, page 307). AWAITING DAN: ship go (0033 prod FIRST).
SHIPPED (2026-08-21): calendar wave merged 3f937a0..daaa6a7, 0033 applied to prod FIRST, pushed. 611 tests. AWAITING DAN: subscribe in his calendar app; FLIGHT_API_KEY signup (lookup only).

--- FORECAST WAVE (2026-08-21, branch forecast, base 1bcc39f, plan docs/superpowers/plans/2026-08-21-cash-flow-forecast.md) ---
Fc Task 1: complete (2274dfb, controller byte-verified)
Fc Task 2: complete (c8d30e2 + fixes 74e828d, review Approved; 652 tests). Note carried to Task 4: voided-invoice shows stay 'billed' upstream -> page must map them back to open.
Fc Task 3: complete (d169991) | Fc Task 4: complete (5fea111, void-defense included)
SHIPPED (2026-08-22): forecast wave merged, 0034 to prod FIRST. 662 tests.

--- FORECAST REFINE (2026-08-22, branch forecast-refine, plan docs/superpowers/plans/2026-08-22-forecast-refinements.md): Net30-for-all, out-of-state travel legs, pm_role + 4h, per-show pay list ---
Refine Task 1: complete (2bbd582, byte-verified)
Refine Task 2: complete (51e0bb3, 672 tests; page.tsx tsc errors expected -> Task 4)
SHIPPED (2026-08-22): forecast-refine merged, 0035 to prod FIRST. 680 tests.
SHIPPED (2026-08-22): travel-days-model merged 47ba97e (no migration). Ten booked shows: $47,450 -> $34,730. 685 tests. Dan deferred the 2-day out-of-state case (really 2 travel + 1 show).

--- DAY TYPES (2026-08-22, branch day-types, plan docs/superpowers/plans/2026-08-22-show-day-types.md): show_days.travel_works, forecast-only ---
DT Task 1: complete (0be84ee; comment corrected + dev rolled back/re-applied before it became immutable)
DT Task 2: complete (5b76c91, 693 tests, controller-verified 6 cases incl. both guards)
DT Task 3: complete (9eb9236, all gates clean)
SHIPPED (2026-08-22): day-types merged, 0036+0037 to prod FIRST. 694 tests. Trigger adversarially verified.

--- SNAP RECEIPT (2026-08-22, branch snap-receipt, spec docs/superpowers/specs/2026-08-22-snap-receipt-design.md): mobile header camera -> today's show -> confirm screen. No migration. ---

--- BUDGET PHASE ONE (2026-08-22, branch budget, base a633185) ---
Spec docs/superpowers/specs/2026-08-22-ynab-budget-design.md (d620ee7, amended 5948d71)
Plan docs/superpowers/plans/2026-08-22-ynab-budget-phase-one.md (76c22b5, pre-flight fixes e5b24e4)
Dan chose: prove parity then switch | owner pay = a real category | targets monthly + by_date only
 | 2026 only | match YNAB's category list exactly | app skin + YNAB bones | desk-first
 | assignments = immutable moves | move-money + undo/redo + recent-moves + filter chips (NO auto-assign)
Arithmetic validated pre-build vs Dan's export: carryover 0/1421 mismatches; RTA = $0.00 Aug 2026.
Phase two (assign by hand, move money, undo/redo, recent moves) = separate plan later.
SHIP ORDER: 0038 then 0039 to prod BEFORE merge.
Tasks: 1 mig 0038 | 2 mig 0039 + seed chart | 2b mig 0040 (owner-pay category + sort fix) | 3 lib/budget.ts | 4 lib/ynabPlan.ts | 5 import
 | 6 page+table | 7 rows+targets | 8 summary+filters+phone | 9 verify+docs+ship
Bg Task 1: complete (e5b24e4..a5853a7, review Approved, zero Critical/Important). Migration 0038
  on DEV. Controller independently re-verified: lt_nocat_for_owner_or_transfer gone,
  lt_nocat_for_transfer = CHECK (kind <> 'transfer' OR category_id IS NULL), budget_role NOT NULL
  default 'spending', both RLS policies present. Reviewer's warning resolved by controller: 0039
  does set deductible=false on Owner Pay (insert row is (name,grp,sort,false,false)).
  MINOR for final review: no constraint ties a move's owner_id to the owner of its
  from/to category — exact parity with 0030's ledger_envelope_moves, not a regression.
Bg Task 2: complete (a5853a7..993a061) — migration 0039 + seed chart + ALIASES emptied + tests.
  Review found 1 Important (plan-mandated sort collisions: Software/Bank Fees @14,
  Flights/Lodging @24, Clear/Subscriptions @13; /money/categories orders by (grp,sort) with
  no tie-break). CONTROLLER ALSO FOUND, by direct DB check, a gap the plan missed entirely:
  nothing ever categorised owner_pay transactions, so the budget's LARGEST row would have
  shown assignment vs ZERO activity and the parity check would fail on the biggest line.
Bg Task 2b: complete (..33b6fcf, plan amended 0fccde9). Migration 0040 closes both:
  owner_pay rows -> Owner Pay category (per-owner correlated, idempotent, cannot touch
  transfers); retired names -> sort 900/901/902 unconditionally; categories page gains
  .order('name') tie-break. Combined re-review a5853a7..33b6fcf: APPROVED, zero findings.
  Controller re-verified on dev: 0 sort collisions any group; 10/10 owner_pay categorised
  totalling -4,593,080 cents (matches prod exactly; the $400 gap vs YNAB is Dan's punch list);
  transfer still uncategorised.
Bg Task 3: complete (33b6fcf..b5325ef + fix 07dc797). lib/budget.ts + 27 tests. Review found
  2 Important, BOTH plan-mandated (my plan's example code), BOTH FIXED:
  I1 hidden spending categories corrupted Ready to Assign — spendingIds excluded them, so a
     txn on a hidden category counted as INCOME and a move into one was dropped; worse, hidden
     is a current flag applied across the whole range, so hiding a category retroactively
     rewrote every past month's RTA. Fix: hidden is presentation-only; all spending categories
     participate in all accounting; CategoryMonth gained hidden:boolean; every total ranges
     over the same set as rows. Comment left in lib/budget.ts:182-187 warning against undoing it.
  I2 funded/overspent could report negative spentCents on net-positive activity (the || 0 guard
     only caught -0). Fix: Math.max(0, -activity) in both branches.
  One pre-existing test asserted the OLD (buggy) contract — implementer correctly stopped and
  asked; controller directed a rewrite, not a delete. Re-review: APPROVED.
  CONTROLLER VALIDATION (run twice, before and after the fix): lib/budget.ts executed against
  Dan's real 1,421-row YNAB export => 1421/1421 availableCents match EXACTLY, 0 mismatches;
  Aug 2026 activity -87018, available 725190, leftOver 812208 — all matching his screenshot.
  Note: that check does NOT cover RTA, any target path, undone moves, income-role categories,
  hidden categories or category-to-category moves. Those rest on the unit tests.
  MINORS for final review: overspent branch's genuinely-negative sub-case untested (funded's is);
  no inline comment on the overspent clamp.
Bg Task 4: complete (79af97d..68ce7f7 + fix 2452ca6, plan escaping fixes 2d96b4d/bd13e07/79af97d).
  lib/ynabPlan.ts + parseCsvRows exported from ynabRegister. Review found 1 Important (both
  defensive branches had ZERO tests — a bare Number() or a deleted length guard would have
  passed all 7) + minors. FIXED: 5 new tests each traced to fail against the specific wrong
  implementation; empty file now throws like its sibling; roundCents reused from lib/money.ts.
  Re-review APPROVED — reviewer brute-forced 2,000,001 values to prove the roundCents swap is
  behaviour-preserving, and confirmed no existing caller of parseYnabPlan to break.
  DECLINED as non-blocking (reviewer concurred independently): reordered-header test
  (structurally guaranteed), minus-after-$ leniency, toMonth case sensitivity.
  CONTROLLER VALIDATION: real export -> 1421 rows, 49 months (2022-08..2026-08), 0 malformed,
  Aug totals matching my independent Python; all 4 guards probed directly and threw with
  line-accurate messages. 756 tests.
NOTE (plan amended 58a09a4): buildBudget now returns a row for EVERY spending category incl.
  hidden, so Task 6's table owns the hiding — empty hidden rows not rendered, hidden rows still
  holding money render in a Hidden group so visible rows still sum to the month totals.
Bg Task 5: complete (58a09a4..49b0630). scripts/import/ynab-plan.mjs + npm run import:plan.
  Review APPROVED, zero Critical/Important. Dry-by-default, --commit to write, pg (not
  supabase-js), banner before connect, delete+inserts in ONE transaction (dry run does the real
  inserts then rolls back), unmatched category = hard error listing ALL names.
  Dev import matched the brief exactly: opening $584.74 = Tax Prep 104.29 + Retained Earnings
  480.45, 9 months 2025-12..2026-08.
  CONTROLLER END-TO-END PARITY CHECK (.superpowers/sdd/parity.mjs, gitignored — reads DEV, runs
  the real buildBudget, compares to the export): 121/136 comparable rows MATCH EXACTLY.
  All 15 diffs trace to Dan's four known ledger gaps, nothing to do with the code:
    Retained Earnings +15/+30/+45  = the three $15 Monthly Service Fee rows still uncategorised
    Audio Tools -19.47/-58.41/-34.63 = -112.51 of missing refunds
    Owner Pay -400 (Mar)             = the unsplit transfer
    Insurance -35 (Jun onward)       = missing refund
  Dev also holds the Fairmont as 3 rows = exactly $592.10 uncategorised, which is why Aug RTA
  reads -601.09 rather than -8.99. Arithmetic right; gaps are data.
  MINORS for final review: --start accepts 2026-13 (shape-only regex); --file can silently
  overwrite an earlier path; the "idempotent by deletion" header claim only holds for a
  repeated run with the SAME --start.
Bg Task 6: complete (49b0630..b06aff3 + fix 42bf832). /money/budget rewritten (envelope panel
  gone, BudgetPanel.tsx left on disk), components/BudgetTable.tsx + BudgetRow.tsx (simple form;
  Task 7 enriches). All 4 reads paged with .range(); all destructure error and return before the
  presence test. Opening balance injected as a null-category txn.
  Review found 2 Important — the FIRST IS THE BEST CATCH OF THE WAVE:
  I1 ?m=2026-13 passed the shape-only regex, was never clamped (lexically > FIRST_BUDGET_MONTH),
     and reached buildBudget as toMonth. The loop's `if (m === toMonth) break` can NEVER match a
     month addMonths produces, so it looped forever — synchronous, so it blocked the event loop
     for that request. A hang reachable by editing the URL. FIXED AT BOTH LAYERS: budget.ts now
     exits on a lexical comparison (terminates for any input; reversed range -> empty map) and
     the page's regex now requires 01-12.
  I2 opening-balance month unguarded — if opening_date ever fell outside [OPENING_MONTH, toMonth]
     the opening balance would vanish from RTA silently. FIXED: injected month clamped.
  Minors fixed too: MAX_MONTHS_AHEAD ceiling (?m=9999-12 was ~95k iterations); account-filter
  risk documented in the source comment rather than only in a report.
  CONTROLLER PROBE of the hang fix: toMonth 2026-13 -> 12 months instantly; reversed -> 0 months;
  normal -> 3. Real export still 1421/1421. 758 tests, tsc + build clean.
  Deviations accepted: month heading is h2 (every /money/* page reserves its single h1);
  .eq('account_id') on the txn fetch (sibling precedent; now documented as understating the
  budget if a second open account ever exists).
  Task 6 RE-REVIEW: APPROVED. Reviewer re-derived the loop fix by hand for every ordering
  (equal bounds, normal, unreachable toMonth, reversed) and confirmed both new tests genuinely
  HANG against the unfixed code rather than merely failing. Opening-balance clamp verified to
  close the vanishing path with no double-count. Two NEW minors, both FOLDED INTO TASK 8:
    - the opening-balance clamp guards only the lower bound; a symmetric Math.min against `last`
      would close the same failure from the other direction
    - the Next-month arrow has no ceiling guard while Previous omits itself at FIRST_BUDGET_MONTH
      — inconsistent, one line, precedent three lines away in the same file
  CONTROLLER BROWSER CHECK (dev server, first render of the screen): /money/budget renders with
  no console errors and reproduces Dan's YNAB screenshot figure for figure — Workers Comp
  72.66/0/218.00, Spotify 12.99/-12.99/0, Clear 14.08/0/84.52, Software 18.99/-64.98/-45.99,
  Meals 0/-40.25/134.75, Transportation 100.00, Taxes 6,164.19. Insurance reads 0.00 vs his
  35.00 (the missing refund) and that propagates to the Bills total 256.53 vs his 291.53 —
  the expected difference, not a defect. RTA -601.09 (dev's uncategorised Fairmont).
Bg Task 7: complete (42bf832..ac1d657 + fixes dbdbfe4, 80f2a4a). BudgetRow enriched (status line,
  progress bar, Available pill), components/TargetEditor.tsx, app/money/budget/actions.ts.
  Implementer raised 2 real PLAN defects rather than papering over them — both were mine:
    - the pill table had no state for "available > 0 and NO target", so such a row got the
      half-circle progress glyph pointing at nothing. Corrected to a six-state table.
    - I had frozen BudgetRow's props, which made it impossible for the editor to know an existing
      target's kind/dueDate — editing a by-date target's amount would have silently dropped its
      deadline. Lifted; target now threaded page -> BudgetTable -> BudgetRow -> TargetEditor
      WITHOUT moving target data into lib/budget.ts's return types.
  Review then found 1 Important + a warning that turned out to be a real hole:
    I1 (plan-mandated) progress-bar arithmetic computed inside the component, outside the
       1,421-row validation. FIXED: exported progressPct(row) from lib/budget.ts + 6 tests.
    WARNING RESOLVED AGAINST US: ledger_category_targets' RLS tests owner_id = auth.uid() and the
       action supplies owner_id itself — so a forged row would satisfy the policy while pointing
       at ANOTHER owner's category, FK included. Nothing stopped it. FIXED: both actions now walk
       the category's own FK to confirm ownership (setTravelLeg doctrine), destructuring error and
       returning before the presence test so it fails closed.
    Minor: radios given explicit value="monthly"/"by_date". (My browser a11y observation was
       wrong — the wrapping <label> does supply the accessible name; reviewer corrected me.)
  CONTROLLER BROWSER CHECK with 4 seeded dev targets — reproduces Dan's YNAB screenshot string
  for string: Workers Comp "Funded" + filled-check green pill $218.00; Spotify "Fully Spent" +
  grey check $0.00; Software "Overspent. $64.98 of $18.99" + red pill -$45.99; Transportation
  (by_date $250 by 2026-12-31) "$150.00 more needed eventually" + half-circle pill $100.00;
  Clear (no target) plain green pill, no glyph. 764 tests, real export still 0 mismatches.
  NOTE: dev has 4 FABRICATED test targets (Workers Comp/Spotify/Software/Transportation) —
  clear them before Dan uses the dev sandbox.
  Task 7 RE-REVIEW: APPROVED. Reviewer verified against the actual diff (not the report):
  progressPct byte-identical to the formula it replaced + 6 edge tests that provably could not
  pass pre-fix; the ownership guard present on BOTH actions, failing closed, and robust whichever
  way ledger_categories' own RLS behaves; radios carry explicit values.
  ONE Important left open by the reviewer as a should-fix follow-up, FOLDED INTO TASK 8 rather
  than filed (deferring a security guard's test to a cleanup wave is how it gets dropped):
  categoryOwnedByCaller has no regression test. Reviewer's argument, which I accept: this is the
  first live-books write path; this exact bug class ALREADY regressed once inside this task; and
  the guard's logic is pure branching over a {data,error} shape, so a stub is enough — no live DB.
Bg Task 8: complete (80f2a4a..053e896 + fix 21aeec5). BudgetSummary panel, 5 filter chips,
  phone card layout, both carried Task-6 minors, AND the ownership-guard test.
  Guard test deviation ACCEPTED and it is the better call: app/**/actions.ts uses @/ aliases
  node --test can't resolve, so the decision was extracted to lib/categoryOwnership.ts —
  which is exactly CLAUDE.md's stated doctrine ("extract their brains into pure libs";
  ledgerRules.ts is the model). Action calls it; no second copy. 3 tests, the load-bearing one
  pinning that a non-null error beats a would-otherwise-pass data (fail-closed ordering).
  Review found 2 Important, both FIXED in 21aeec5:
  I1 category names crushed at desktop width — the status wrapper had shrink-0 so the NAME
     absorbed all the squeeze. Latent until the summary panel narrowed the table's grid track.
     Controller reproduced: Software -> "So…", Transportation -> "T". Fixed by inverting the
     priority; the status truncates now. Controller re-verified visually at 1440x900: names
     render in full, status ellipsizes.
  I2 (plan-mandated) Overfunded could select a row whose own status read "more needed" —
     available includes this month's activity, neededCents doesn't. Fixed with
     row.neededCents === 0 && in the predicate, commented so it isn't "simplified" back.
  CONTROLLER WALKTHROUGH: summary panel figures reconcile (our Available 7,261.90 vs YNAB
  7,251.90 = Retained Earnings +45 minus Insurance -35, both punch-list items); Overspent
  filter shows 3 rows while the Bills group total STAYS whole-month at 118.72/-77.97/256.53;
  phone layout stacks to labelled three-up rows, chips wrap, no horizontal scroll.
  767 tests, tsc + build clean.
  Task 8 RE-REVIEW: APPROVED. Reviewer proved the name column is a CONSTANT ~224px across the
  whole desktop-with-sidebar range (AppShell's max-w-5xl cap and the lg breakpoint both land on
  1024px), so there is no narrower desktop case to check; and traced every statusFor path to
  confirm the Overfunded clause excludes ONLY the contradictory case, never a genuinely
  overfunded row. Minor process note: the fix round started the dev server with `npm run dev`
  in Bash despite the brief saying to use the preview tool — disclosed, stopped before gates.
DOCS (d551f57): CLAUDE.md carries both formulas + the rules not to re-derive (hidden is
  presentation not accounting; budget_role never inferred from grp; filters never change totals;
  the constraint swap and why the CPA export is unchanged). BACKLOG entry rewritten as SHIPPED
  with phase two, every deferred item, and Dan's 5-item ledger punch list.
ALL BUILD TASKS COMPLETE — final whole-branch review (opus, per Dan's tiering) next.
FINAL WHOLE-BRANCH REVIEW (opus, a633185..d551f57): **FIX FIRST**. Found a CRITICAL that every
  per-task review missed because it only exists at the seam between the migration and the rest
  of the app:
  C1 0040 backfilled the Owner Pay category onto owner_pay rows, but EVERY write path still
     enforced the old rule — validateTxnShape rejected it, MoneyRegister hard-coded categoryId
     null for that kind on both add and edit, setTransactionCategory returned early, CategoryText
     printed "Owner pay" so the loss was invisible, and ynabRegister threw on it. So editing any
     owner-pay row deleted the category 0040 set, and new draws were never categorised. Because
     lib/budget.ts routes anything without a spending category into income(m), one missed draw
     leaves Owner Pay at $0 activity AND pulls the draw out of Ready to Assign — two wrong
     figures, opposite directions, largest line, silent. Would have reconciled today and drifted
     the first time Dan paid himself.
  I2 budget_role written ONLY by migrations — ensureDefaultCategories and saveCategory both
     dropped it, and the test asserted a value the write path discarded. A new income category
     would silently be a spending row.
  I3 the import script's opening month and OPENING_MONTH agreed only by convention; a later
     --start would write the carry-in TWICE.
  I4 the forecast's comment described a caller that no longer exists (comment-only fix; the
     behaviour — forecast presents budget-assigned money as free to spend — is deferred).
  FIX WAVE (8 commits 7a423da..7da7ad6): all of the above plus stale constraint comments, phone
  group headers, a React key collision on a synthetic "Hidden" section, --start swallowing
  --commit, the overspent clamp's missing test+comment, and deleting dead BudgetPanel.tsx +
  ensureDefaultEnvelopes. 769 tests, tsc + build clean, real export still 0 mismatches.
  CONTROLLER VERIFIED C1: test matrix pins owner_pay+category VALID and transfer+category
  REFUSED; no hard-null left in the register; zero stale lt_nocat_for_owner_or_transfer refs;
  dev's 10 owner_pay rows still categorised, transfer still not.
  DOCS de2529e: punch-list item 4 was IMPOSSIBLE as written (no split UI, no Temporary Transfer
  category, transfers still can't carry one) — restated as an accepted $400 variance. Deferred
  deviations recorded: wide canvas, collapsible groups, 2025-backdated rows, dead envelope actions.
AWAITING DAN: ship go. SHIP ORDER 0038 -> 0039 -> 0040 to PROD FIRST, then import:plan --prod
  --commit, then merge+push. Dev has 4 fabricated test targets to clear.
FINAL RE-REVIEW (opus): **READY TO MERGE.** C1 verified closed on EVERY category_id write path
  (add, update, setTransactionCategory, the same-payee sweep, OFX import, the backfill script);
  the fix went further than its report claimed — the sweep needed an explicit kind re-gate
  because fetchUncategorizedSamePayeeCandidates is typed to income|expense and the old owner-pay
  early-return was the only thing keeping owner_pay out of that parameter. assertInvariants lost
  exactly the one clause and nothing else. lib/budget.ts and all three page diffs comment-only,
  so the 1,421-row reproduction rests on untouched arithmetic.
  Reviewer named ONE thing it would want changed, introduced by the fix wave: the new Income
  checkbox in CategoryEditor was UNGUARDED — ticking it on a category with history retroactively
  rewrites every month (its txns become income(m), its moves stop counting toward assigned, its
  Available leaves every total, RTA changes for all 8 months). Reversible and deliberate, so not
  merge-blocking, but unguarded in a codebase whose own saveEnvelope already refuses server-side
  to hide an envelope holding money. FIXED ANYWAY (de68beb) before shipping:
  lib/incomeRoleGuard.ts + 6 tests — refuses the flip when the category has non-undone budget
  moves or a target, checks error BEFORE the presence test on BOTH reads (fails closed),
  no-ops when already income. Plus: inline picker now offered for owner_pay (the one path a
  reconciled uncategorised owner-pay row could have been stranded), and payeeMemory's stale
  justification corrected.
STATE: 36 commits ahead of main, tree clean, 775 tests, tsc clean, build clean, real export
  1421/1421. Dev targets cleared. AWAITING DAN: ship go.
  SHIP ORDER: 0038 -> 0039 -> 0040 to PROD FIRST; then npm run import:plan -- --prod (preview)
  then --prod --commit; then merge + push; then prod smoke.
MONTH PICKER (2026-08-23, ef7bbf1 + dead-code delete 4a27fb3): Dan asked for a YNAB-style month
  picker, thinking ahead to 2027 when stepping back a year would be 14 clicks. His 2nd screenshot
  settled the out-of-range treatment: GREY THEM OUT, don't hide. Built components/MonthPicker.tsx.
  Implementer caught a contradiction in my brief (the year-arrow rule makes 2025 unreachable, but
  a check bullet asked to step into it) and implemented the stated rule — its reading was right.
  It also self-disclosed and fixed a real bug: outside-click left focus on <body> because
  mousedown's default focus action overwrote the explicit .focus(); fixed with preventDefault(),
  the same technique components/ui/Select.tsx already uses.
  CONTROLLER BROWSER VERIFICATION: 2026 + 2027 all months available; 2028 Jan-Aug available,
  Sep-Dec GREYED (ceiling = Aug 2028); Next year disables at 2028; Previous year disabled at 2026;
  Aug carries aria-current; every month link AND both header arrows carry &f=overspent (they used
  to drop the filter); at January the Previous arrow renders as a DISABLED button instead of
  vanishing. Review: APPROVED, Minors only (untested pure predicates, focus-on-outside-click
  scope, a dead filterQuery half-condition, year arrows identical at rest) — all backlogged.
  775 tests, tsc + build clean.

--- WAVE A (2026-08-23, branch budget, base d4c75d3): walkthrough unblockers ---
Plan docs/superpowers/plans/2026-08-23-wave-a-unblockers.md (d4c75d3 + hidden-four drop).
Dan: hidden four (Apple Music/Waves/YNAB/Mexico) NOT restored — verified 0 txns in 2026.
Tasks: 1 delete RENDER_CAP | 2 mig 0041 full chart (Hotels rename, 7 inserts, resorts)
 | 3 budget column headers | 4 sticky register header | 5 controller wrap-up.
SHIP NOTE: prod order now 0038->0039->0040->0041; delta review after de2529e before the gate.
Wave A Task 1: complete (92fe15a, review Approved; cosmetic blank-line nit fixed in wrap-up).
Wave A Task 2: complete (e5a6f30, review Approved — migration proven no-op-safe on fresh+prod;
  Lodging->Hotels rename found to be LOAD-BEARING for future imports, YNAB's live export says
  Hotels; tests strengthened not loosened. Controller re-verified chart on dev: 29 rows exact,
  0 collisions). Stale Lodging comments fixed in wrap-up.
Wave A Task 3: complete (336eca0, controller byte-verified vs plan — 9 lines verbatim).
Wave A Task 4: complete (0725c25). Browser-pane screenshot capture broke mid-session (solid
  black on scrolled tabs); implementer verified via DOM geometry (top:64px pin at scrollY 9538,
  grip drag while stuck 212->233px, Select z-30 above header z-10) + one clean pre-bug shot.
Wave A wrap-up: nit fixes + docs. Controller pass: 325 rows rendered (January reachable),
  "Showing the latest" gone, sticky classes live, budget headers over their columns, all 8
  categories on budget + categories pages. 776 tests, tsc + build clean.
WAVE A COMPLETE ON DEV. Awaiting Dan's re-walk + ship decision (0038-0041 prod first, delta
  review after de2529e at the gate).
SHIP IN PROGRESS (2026-08-23, Dan's go):
  Delta review (opus, de2529e..587ebf1): FIX FIRST narrowly — but EXPLICITLY cleared the prod
  migration given a pre-flight. Merge blocked on: I2 income-role guard missing the transactions
  check its own comment promises; I3 MonthPicker document-level preventDefault breaks first-click
  focus page-wide (false Select.tsx precedent); CLAUDE.md doctrine staleness; I4 written down.
  PRE-FLIGHT (prod): Lodging grp=Expenses sort 24; none of the 8 names pre-exist; 17 cats. CLEAN.
  PROD MIGRATED: 0038,0039,0040,0041 all ok. Verified: 0 collisions, 29 cats (2 hidden),
  Spotify 8/Clear 1/Subscriptions 0, owner_pay 10/10 categorised, lt_nocat_for_transfer only.
  PROD IMPORT: preview matched dev byte-for-byte; COMMITTED — 97 moves, 2025-12..2026-08,
  opening 584.74 (Tax Prep 104.29 + Retained Earnings 480.45), identical to dev month-for-month.
  DOCS (2dc90a2): CLAUDE.md cap doctrine + 0038-0041; BACKLOG envelope bullets corrected, $400
  claim qualified, I4 (ynabRegister Owner-Transactions collapse) recorded with manual workaround.
  WAITING: fix subagent (I2, I3, uuid guard, comment minors, month h2) -> re-review -> gates ->
  merge -> push -> prod smoke.
  Fix wave 19a94d8/6cca0a4/88ca6b5 + docs 2dc90a2. Delta reviewer VERIFIED each fix against the
  named failure modes (outside-click still closes, uuid regex accepts every canonical uuid,
  h2 display:contents inert to layout/popover) and independently reconciled the prod chart
  arithmetic (17+5+7=29). FINAL VERDICT: READY TO MERGE.
  Final gates on merge candidate 2dc90a2..88ca6b5 tip: 778 tests, tsc, build, 1421/1421. MERGING.
SHIPPED (2026-08-23): budget merged a633185..8b4fb03, pushed, Vercel deploying.
  42 files, +6470/-847. Branch `budget` retained locally until prod smoke passes.

--- PUNCH CHIPS (2026-08-24, branch punch-picker off main): tap-to-commit punch times ---
Dan: the iOS picker checkmark felt final, nearly missed punches; rejected punch-now-edit-after
(he punches 15-60min late constantly); agreed design = quick row (nearest quarter-hours, today
only) + hour grid -> quarter chips, tapping a time COMMITS; date field stays for overnight;
"Exact time…" keeps the old input+Save for a 5:07.
Task 1: c180659 (+207/-49, PunchClock.tsx only). Review found 1 CRITICAL, deterministically
  reproduced: nearest15 wraps 23:53-23:59 to "00:00" BEFORE the quick-row boundary filter runs,
  so for 7 min/day the "Now" chips would commit against TODAY's date — 24h wrong, silently, in
  exactly Dan's late-night punch-out window. FIXED 14290e7: center computed from raw minutes
  (no nearest15 for the center), filter now sees out-of-day candidates. Traces: 23:55 ->
  ['23:45']; 00:05 -> ['00:00','00:15']. Minors landed: guard comment names the wrap-before-
  filter gap; per-chip "Saving…" feedback. No automated test (private helper in a 'use client'
  file) — accepted on trace evidence, reviewer reproduced byte-for-byte. RE-REVIEW: READY TO
  MERGE. Controller browser pass: past-day dialog = hour grid, no quick row, Exact time link.

--- BUDGET PHASE TWO (2026-08-24 overnight, branch budget-phase-two off main 039ebbe) ---
Dan picked lane 1 only for overnight. Plan docs/superpowers/plans/2026-08-24-budget-phase-two.md.
NOTHING MERGES OVERNIGHT; prod untouched; morning = his walkthrough + ship gate.
Tasks: 1 lib/budgetMoves (TDD) | 2 four actions | 3 AssignedCell+MoveMoneyDialog | 4 undo/redo+
recent moves | 5 defuse import + docs | 6 final opus review + controller walkthrough, then STOP.
P2 Task 1: complete (85322e8 + guard b401203, review Approved; controller probed all 8 paths).
P2 Task 2: complete (8742134, review Approved). Sign convention verified matching buildBudget;
  insert shape unviolatable; fail-closed everywhere; ownership+role/hidden gated with grown tests.
  CARRIED TO FINAL REVIEW (Important): redo supersession is TOCTOU — read-then-write, precondition
  not encoded in the UPDATE's WHERE (undo's is). Options: accept-with-comment (single-user,
  recoverable) or Postgres RPC. Task 6 decides. Minors: dead {ok:true} branch; benign extras.
P2 Task 3: complete (8402d1d, review pending). AssignedCell + MoveMoneyDialog wired; browser-
  verified assign up/down/equal/garbage + cover-overspent-via-pill; RTA invariant held on
  cat-to-cat move; dev left byte-identical (3 test moves made and reversed through the UI).
P2 Task 3 review: Approved, 3 Minors — 2 fixed controller-direct 5c950cc (RTA->RTA caught
  client-side; category name in dialog heading); Select-Escape-bubbles is a pre-existing
  app-wide idiom, out of scope, noted.
P2 Task 4: complete (a22cba7, review IN FLIGHT). BudgetHistory beside the chips; states derived
  server-side from already-paged moves via redoTarget; list read-only, stack-head undo only.
  Dev restored through the UI. NOTE: task-brief's dev-login instructions were wrong (secret-param
  API); the plain /login form works — fix future briefs.
P2 Task 5: complete (6a779d9, haiku; per-task review skipped for scope — final review explicitly
  checks the import defusal). Import refuses --commit when ANY moves exist unless --replace,
  before BEGIN, printing count + month range. Docs corrected fbac72d: phase two is BUILT not
  shipped — the gate is Dan's.
NEXT: Task 4 review verdict -> fixes if any -> Task 6 final opus review (must decide redo TOCTOU:
  accept-with-comment vs RPC) -> controller walkthrough -> STOP for morning.
P2 Task 4 review: Needs fixes -> controller-fixed abfee0a (sr-only undone signal; Enter-path
  RTA guard now matches sameCategory; isNewer exported + shared). Approved-equivalent.
P2 FINAL REVIEW (opus): FIX FIRST — the finding of the wave: THE BACKFILL SHARES ONE created_at
  (single transaction), so undo past the hand moves was a RANDOM UUID WALK through 8 reconciled
  months, and Redo (ordered by created_at) wasn't Undo's inverse there. Plus: the import
  defusal's refusal CRASHED instead of printing (pg returns date as JS Date; .slice threw —
  the guard had NEVER executed); pill/blur stale-prefill race; negative-Assigned papercut;
  LOWs (Select Escape bubble, blank-blur zero, unpaged sum read, unwired `wrote`, phone scroll).
  TOCTOU DECIDED: accept-with-comment (cannot corrupt, recoverable, single-user; RPC =
  a gate-morning migration — worse deal).
FIX WAVE 3053bad..5b7fcf7 (6 commits): all fixed. Import refusal EXECUTED on dev for real:
  "REFUSED: --commit found 106 move(s) ... 2025-12 to 2026-08", nothing deleted. 814 tests,
  tsc+build clean, tripwire 1421/1421 before AND after. Re-review dispatched.
P2 RE-REVIEW: **READY FOR THE MORNING GATE.** Reviewer found the undone_at fix cures MORE than
  claimed — the old order also broke ordinary multi-step hand-move undo (restored the wrong row,
  stranded its sibling as 'superseded' forever). Prose/tests understated it; one test passed
  under BOTH comparators. Controller corrections 0c85e2f: honest comments in three places, the
  test rewritten to the reachable discriminating sequence, wrote:false now notes AND refreshes.
  814 tests, tsc + build clean.
CONTROLLER WALKTHROUGH: history UI live (informed Undo label, Redo correctly greyed, Recent
  Moves open, struck-through entry visible); real browser gesture assigned $25 RTA->Insurance
  (verified in DB), Undo clicked, undone_at set (verified in DB), dev restored to baseline.
PHASE TWO COMPLETE ON BRANCH budget-phase-two (unmerged, 17 commits ahead of main 039ebbe).
  Prod untouched. STOPPED per plan — morning gate is Dan's. Ship = gates + tripwire re-run,
  merge, push, prod smoke. NO migration needed.
P2 SHIP (2026-08-24, Dan's gate after his own dev testing): Dan found the move dialog's Select
  clipping + specified YNAB's directional popover (screenshots) — DECISION: ship as-is, redesign
  = Wave B Task 3b on CategoryPicker (added to plan 7348e1a+). Gates 814/tsc/build/tripwire
  1421/1421 clean. Merging budget-phase-two + Wave B plan into main.

--- WAVE B (2026-08-24, branch register-edit off main f4da7ff): register editing ---
Dan approved BOTH gated calls: retire the kind dropdown (derivation table in plan Task 5,
incl. Payment/Transfer pinned row in CategoryPicker = first form path to create transfers,
properly unblocking the $400 inflow leg) + show tag off the row (edit-only, Task 6).
Plan docs/superpowers/plans/2026-08-24-wave-b-register-editing.md. Tasks: 1 moneyMath (TDD)
| 2 add/edit rows onto the live registerTemplate w/ Outflow-Inflow boxes | 3 CategoryPicker
w/ budget balances | 3b directional move popover (Dan's YNAB spec) | 5 kind retirement |
6 show tag | 7 final review + Dan's gate.
HOTFIX (main a93842a, Dan mid-use on prod): Recent Moves starts CLOSED — his call overriding the
  review's open-by-default belt; the Undo button label keeps the informed-undo job. Shipped.
WB Task 1: complete (fc55ecf + guards 190244c). lib/moneyMath.ts — parseUSDMath, delegation to
  parseUSD for lone values, one-rounding taint model. First agent run was KILLED by laptop sleep
  (nothing written); resumed clean. Review found 1 Important REAL: deep-nested parens/signs blew
  the call stack (totality contract false; call sites don't catch) — FIXED: 200-char guard +
  top-level catch; plus the two missing regression tests (chained /* single-rounding, 1e3
  rejection). 833 tests. Controller probed 9 cases incl. Dan's own; 50k-paren blob -> null.
  FOR DAN AT SHIP: the (5.75) seam — lone "(5.75)" is parseUSD's accounting-negative -5.75,
  but "(5.75)+1" is grouping +6.75. Reviewer wants it surfaced, not buried.
WB Task 2: complete (04ce1ac, review pending). Add/edit rows on the LIVE registerTemplate,
  Outflow/Inflow boxes w/ exclusivity + kind-flip, second line (Kind/Show/Save/Cancel/Delete),
  browser-verified incl. mid-grip-drag; dev reset. Pre-existing grip double-click quirk
  documented, out of scope.
PARITY MILESTONE (2026-08-24): Dan cleared the punch list (Hartford $35 inflow 6/29; three $15
  fees -> Retained Earnings; Audio Tools refunds he'd already entered; $400 variance dissolved at
  the August-available level). YNAB token wired; npm run parity committed (99fe0db + 4696cf1,
  usd-hoist fix after I committed before rerunning — wrong order, caught immediately).
  RESULT: 25/25 categories EXACT live vs YNAB's API; RTA app $1.01 vs YNAB $0.00 = the Novo
  remainder precisely. Total parity. September month-end = one command.
WB Task 3: complete (5f2e243) + review found 1 Critical (selected category rendered TWICE with
  duplicate DOM ids on every reopen — the majority interaction) + 2 Important (pinned rows
  keyboard-unreachable; blankOption prop can't host Task 5's Payment/Transfer).
WB Task 3b: complete (df0a27b, unreviewed at the time) — MovePopover replaces MoveMoneyDialog
  (deleted); directional per Dan's spec; clipping verified dead; found+fixed a real CategoryPicker
  display-label bug live.
FIX WAVE 9222eef: dedupe (once under Selected, YNAB-style); pinned rows joined the virtual
  activedescendant list (+ 3 latent ''-is-falsy bugs found); pinnedOptions[] generalization
  landed across all 4 call sites; role=group; parity name-collision warning.
NEXT: combined review of df0a27b + 9222eef, then Task 5 (kind retirement), Task 6, final review.
Combined 3b+fixes review: Needs fixes NARROWLY — all money logic verified correct against source
  (argument order both directions, shortfall exact, From-filter structural, RTA via pinnedOptions,
  anchor/flip math, dialog fully deleted). Two leftovers fixed controller-direct cb912d1:
  pinned rows relocated INSIDE role="listbox" (real ARIA containment problem — options outside a
  listbox ancestor aren't options to the accessibility tree) + error added to the reposition
  effect's deps. Task 5 explicitly unblocked by the reviewer.
WB Task 5: complete (a6edf64) — kind derives; Payment/Transfer = first form path to transfers;
  transfer rows editable for the first time. Task 6: complete (bde34c0, controller-direct).
WB FINAL REVIEW (opus): FIX FIRST — H1 MY plan's derivation table keyed owner_pay on the GROUP;
  the real group holds 5 categories, only 1 is owner pay (Charitable Giving would vanish from
  the P&L's expense side); H2 inline picker could mint rows the edit form refuses + payee memory
  would propagate them; H3 type-filter+Enter picked pinned rows; M1 /money died for a decoration;
  M2 refusals rendered off-screen.
FIX WAVE (interrupted by laptop move mid-dispatch — first fixer killed leaving uncommitted work;
  second agent AUDITED+COMPLETED it): 3ff8598..6c29aaa, 5 logical commits. Completing agent
  found+fixed a REAL regression H2 itself created: applyToAll re-invokes on the anchor row whose
  kind now reflects the first write — owner-pay sweep silently swept 0; fixed by deriving from
  the stable direction. RE-REVIEW: READY FOR THE GATE — reviewer PROVED the reused-kind sweep
  argument from the DB sign constraints; verified security equivalence of the H2 guard read;
  named two accepted widenings FOR DAN: (1) owner_pay rows can now initiate sweeps; (2) a
  reconciled UNCATEGORIZED row's kind can change via the inline picker (balances unaffected).
GATE FOLD-INS 26ea1b5: plan's derivation table corrected to what shipped; stale comment; add-row
  error copies gated on editingId; bottom error node dropped role; BACKLOG Wave B closed w/
  residuals listed. DATA CHECK: 0 stranded income-category expense rows on dev AND prod.
CONTROLLER PASS: register renders on branch — kind dropdown gone, 2+2 amount boxes, show tags
  gone, add row aligned. 847 tests, tsc+build clean. AWAITING DAN'S GATE.
WAVE B SHIPPED (2026-08-24, Dan's gate after seeing the picker live): merged a93842a..HEAD,
  pushed. 847 tests, tripwire 1421/1421 at the gate. Stray dev server (PID 50973) stopped for
  the build gate. No migration.

--- WAVE C (2026-08-24, branch splits-pending off main 6af4bcd): splits + pending ---
Spec 8bdda0a (Dan-approved w/ his YNAB split-editor screenshot; $400 = the defining cross-kind
example; balance option 1; reject-tombstone; reconcile-refusal). Plan committed.
DAN PRE-AUTHORIZED THE SHIP: "push to main when done if it passes all your tests" — 0042 prod
first, merge, push, smoke, parity. Tasks: 1 mig 0042 | 2 lib/ledgerSplits TDD | 3 actions+
importer | 4 register UI (SplitEditor, Pending section) | 5 consumers via ONE helper | 6 docs |
7 final review + ship.
WC Task 1: complete (481e94a + plan note). 0042 (legs+deferred trigger+RPC, rejections,
  entered_at backfilled 325/325) + 0043 (RPC anon-EXECUTE revoke — implementer CAUGHT that
  Supabase's default grant survives `revoke from public`, followed the 0024 precedent rather
  than editing the immutable 0042). Nine proofs pasted, all refusals refuse, RPC nulls parent
  category. SHIP = 0042+0043.
WC Task 1 review: Needs fixes — CRITICAL: reconcile_ledger_account's fixed column list predates
  entered_at -> every future reconcile adjustment lands PENDING FOREVER (unreachable via Enter
  Now — reconciled rows never queue). Task 3's implementer had ALREADY found the same gap
  independently and written 0044. Review also: no-DEFAULT = fail-dangerous posture; RPC/direct-
  write leg path lacks category/txn ownership at the DB. Task 2 review: Approved (1 Minor:
  transfer zero/zero corner — comment tightened; replaceSplits refuses transfer parents anyway).
WC Task 3: complete (bb4f602) — actions, importer pending+tombstones, split-parent refusals,
  reconcile refusal; FOUND the reconcile gap; 0044 authored.
0044 EXPANDED BEFORE FIRST APPLY (0207708 — unapplied migrations are the editable kind):
  + entered_at DEFAULT now() (forgetting = entered; only the importer's explicit null = pending)
  + legs ownership trigger (leg.owner must equal txn owner; categorised leg's category must too)
  — closes the direct-PostgREST door the RPC can't see. Applied to dev; foreign-owner leg PROVEN
  refused; default proven 'now()'. 872 tests.
WC Task 3 review: Needs fixes — 1 Important FIXED controller-direct 5cf2531: updateLedgerTransaction's
  split gate now also fires on a CATEGORY change (stale tab could un-null a split parent's
  category and teach payeeMemory a lie — reviewer traced the exact two-tab sequence); backfill
  INSERT sets entered_at explicitly (house rule, not the default). Reviewer PROVED the importer's
  tombstone stubs can't disturb GEN occurrence math and that explicit null survives the new default.
WC Task 4: complete (8d7020b, review pending) — SplitEditor inline on the live template,
  Split (N) display, Split… pinned row (edit only), Pending section + Enter Now/All + Reject,
  phone Uncleared rename. Browser-verified the full $400 cross-kind flow, Approve-on-pending,
  tombstone cascade. Two ride-alongs for final review's scope check: apply-to-all count and the
  uncategorized queue now exclude split parents. Dev restored (325/2/$7,252.91 — note uncat is
  2 not 3: Dan categorized one on prod?? NO — dev: earlier baseline said 3; VERIFY at Task 7).
WC FINAL REVIEW round 2: F1 (the corrected instruction had missed the SHIP CHECKLIST itself —
  "corrected everywhere except the place that executes") + F2 (Matches badge counted pending) —
  both fixed 206449c. Round 3: READY TO SHIP, every fix re-verified at HEAD.
WC SHIP (Dan's standing pre-auth): 0042+0043+0044 applied to PROD, verified — 325/325 entered,
  default now(), both tables present. Merging.
WAVE C SHIPPED (2026-08-24): merged 6af4bcd..e81ae70, pushed. POST-SHIP PARITY THROUGH THE NEW
  EXPLOSION PATH: 25/25 exact, RTA = the Novo penny — the wave provably changed nothing.
  21 files, +3299/-109. Branch pruned.
--- Auto-assign wave (plan: docs/superpowers/plans/2026-08-25-auto-assign.md, branch auto-assign, base 52507a9) ---
Task 1: complete (5320cc4, controller-verified verbatim vs plan + dev apply)
Task 2: complete (379f4b1, review clean)
Task 3: complete (6afc02b, review clean; minors: double todayInChicago snapshot, stale 'budget' word in carried comment, batch undone_at race nano-note — all accepted)
Task 4: complete (bc92cd9, review clean, zero findings)
Task 5 walkthrough: PASS (button  = by-date share + hidden monthly; tap funds, RTA negative ok; batch 47ff4056 shared id + note; one-tap undo both rows same undone_at; informed label 'Undo auto-assign (2 categories, $85.00)'; one-tap redo restores; sandbox cleaned)
Task 5: docs+final review complete (READY FOR THE GATE, 0 critical/important, 5 minors all doc-triaged; walkthrough PASS). Awaiting Dan's ship gate: prod 0046 FIRST, then merge/push/smoke/parity.

SHIPPED 2026-08-25: prod 0046 applied and column-verified FIRST (the deployed code selects batch_id
  on every budget page load — migrating second would have broken the whole page, not just the button),
  then merged 52507a9..a4a9f8e, pushed, smoke money=307 budget=307 on poll 1, branch pruned.
  POST-SHIP: prod holds 97 moves / 0 batched (every hand move stays single-flip, as designed);
  PARITY 25/25 exact + $1.01 Novo — the wave provably changed no numbers.
  Dan out of credit here; next session resumes from a clean main with nothing pending.
--- Calendar show-bars wave (plan: docs/superpowers/plans/2026-08-25-calendar-show-bars.md, branch calendar-bars, base a4b4a6e) ---
Task 1: complete (e37f207, review clean — reviewer fuzz-probed span/lane/overflow invariants, zero findings)
Task 2: complete (7360b77 + fix 
87e5dcc, review clean; minor money-guard coverage drift fixed by controller)
Task 4: docs + final review (READY FOR THE GATE, 0 critical) + fix wave 37d55a2 (cross-week lane continuity via layOutMonth; pre-0047 feed fallback; 4 minors). WALKTHROUGH PASS: corners verified in computed CSS (Crosser L=0px/R=4px, OverlapB wk1 L=4/R=0, wk2 L=0/R=4, FullWeek span7 both 4px); OverlapB holds lane 1 across the week break (was 1->0); empty cell -> day dialog; bar -> /shows/<id>; mobile 375px renders bars + flight dot; feed DTENDs exclusive (Crosser 0828->0904, single-day 0901->0902). Sandbox seed removed. AWAITING DAN'S SHIP GATE: prod 0047 FIRST, then merge/push/smoke.

SHIPPED 2026-08-25: prod 0047 applied and verified FIRST (RPC returns show_id; anon+authenticated grants preserved by create-or-replace), then merged a4b4a6e..37d55a2, pushed, smoke calendar=307 money=307 on poll 1, branch pruned.
  LIVE FEED VERIFIED: 15 events = 13 show RUNS + 2 flights, ZERO legacy showday UIDs. A1 PwC 11/06->DTEND 11/15 (9 days), PwC TAX 08/28->DTEND 09/04 (month-crossing). Exclusive DTEND correct on real data.
--- Short-paid settlement wave (plan: docs/superpowers/plans/2026-08-25-short-paid-settlement.md, branch short-paid, base 0053b3b) ---
Task 1: complete (7dd4018 + fix d9b1aa0, review clean). Implementer caught a PLAN defect: the plan's verbatim lib failed the plan's verbatim zero-total test (-0 vs 0 under assert/strict). Controller replaced || 0 with an explicit zero check so NaN stays visible.
Task 2: complete (4265d9a, review clean, zero findings — combo count traced by transaction_id against 0032's unique constraint)
Task 4: final review returned FIX FIRST (C1: picker offered PENDING rows — reintroduced the Wave C hazard; I1 unranged link reads truncate at 1000; I2 limit-before-filter + duplicate-inviting empty state; M3 unread link error). ALL FIXED in c03d595 (both layers: picker filter AND acceptIncomeMatch refusal). WALKTHROUGH PASS: pending $590 deposit planted and NOT offered; short settle -> 'Paid $590.00 · $10.00 short', paid_at = deposit date 8/20 not today; over settle -> '$10.00 over $450.00'; unlink reverted 99001 to sent/paid_at null while 99002 stayed settled. Sandbox cleaned. AWAITING DAN'S SHIP GATE (no migration: merge/push/smoke).

SHIPPED 2026-08-25 (fourth wave of the day): short-paid settlement. No migration, so merge 0053b3b..c03d595, pushed, smoke invoices=307 money=307 on poll 1, branch pruned. 925 tests.
  PROD NOTE: real #385 is ALREADY hand-marked paid (paid_at 2026-08-25 = the day he clicked, NO link), total $6,553.14. The panel covers exactly that case (no link + status paid), so attaching the real deposit later will fix the date AND record the shortfall. That deposit is NOT yet in the prod ledger (no income row 6400-6600) — it arrives with his next import.
