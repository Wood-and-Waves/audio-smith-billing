'use client'

import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { saveSettings } from '@/app/settings/actions'
import { FIELD_FULL } from '@/components/ui/field'
import Select, { type SelectOption } from '@/components/ui/Select'

type Appearance = 'system' | 'light' | 'dark'

const APPEARANCE_OPTIONS: SelectOption[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
]

export type EditorSettings = {
  business_name: string
  legal_name: string
  address_line1: string | null
  address_line2: string | null
  phone: string | null
  email: string | null
  remit_to: string | null
  ach_details: string | null
  default_terms_days: number
  next_invoice_number: number
  tax_setaside_bp: number
  monthly_take_home_cents: number
  monthly_overhead_cents: number | null
  billing_lag_days: number
}

export default function SettingsEditor({ initial }: { initial: EditorSettings }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const [businessName, setBusinessName] = useState(initial.business_name)
  const [legalName, setLegalName] = useState(initial.legal_name)
  const [addressLine1, setAddressLine1] = useState(initial.address_line1 ?? '')
  const [addressLine2, setAddressLine2] = useState(initial.address_line2 ?? '')
  const [phone, setPhone] = useState(initial.phone ?? '')
  const [email, setEmail] = useState(initial.email ?? '')

  const [nextInvoiceNumber, setNextInvoiceNumber] = useState(String(initial.next_invoice_number))
  const [termsDays, setTermsDays] = useState(String(initial.default_terms_days))
  const [taxSetasidePct, setTaxSetasidePct] = useState(
    initial.tax_setaside_bp === 0 ? '' : String(initial.tax_setaside_bp / 100),
  )

  // Dollars in the field, cents in the row — same shape as taxSetasidePct
  // above (percent in the field, basis points in the row): blank means
  // "unset" and converts to a default on save, never a typed 0.
  const [monthlyTakeHome, setMonthlyTakeHome] = useState(
    initial.monthly_take_home_cents === 0 ? '' : String(initial.monthly_take_home_cents / 100),
  )
  // Unlike take-home, null here is not "unset" — it's "use the computed
  // average," a real and distinct choice, so an actual $0 override must
  // round-trip as "0", not blank.
  const [monthlyOverhead, setMonthlyOverhead] = useState(
    initial.monthly_overhead_cents === null ? '' : String(initial.monthly_overhead_cents / 100),
  )
  const [billingLagDays, setBillingLagDays] = useState(String(initial.billing_lag_days))

  const [remitTo, setRemitTo] = useState(initial.remit_to ?? '')
  const [achDetails, setAchDetails] = useState(initial.ach_details ?? '')

  // Per-device Appearance. This is NOT business data — it never leaves the
  // browser, isn't part of `initial`/`saveSettings`, and its default here
  // ('system') must match what an absent localStorage key means everywhere
  // else (the pre-paint script in app/layout.tsx, the CSS in globals.css).
  // Reading localStorage happens in an effect, not during render, so the
  // server-rendered and first-hydrated markup both start at 'system' — SSR
  // has no localStorage, and disagreeing here would trip a hydration warning.
  const [appearance, setAppearance] = useState<Appearance>('system')

  useEffect(() => {
    try {
      const stored = localStorage.getItem('theme')
      if (stored === 'light' || stored === 'dark') setAppearance(stored)
    } catch {
      // Storage can throw (Safari private mode, disabled storage) — the
      // 'system' default set above already covers that case.
    }
  }, [])

  // Applies immediately on change, independent of the Save button below.
  // Deliberately not folded into submit()/saveSettings: this is device
  // state (where THIS browser renders), not business data that belongs in
  // the settings row or needs a round trip to the server.
  function onAppearanceChange(next: string) {
    const value = next as Appearance
    setAppearance(value)
    try {
      if (value === 'system') {
        localStorage.removeItem('theme')
        delete document.documentElement.dataset.theme
      } else {
        localStorage.setItem('theme', value)
        document.documentElement.dataset.theme = value
      }
    } catch {
      // Best-effort, same as the mount effect above — the visible <html>
      // dataset was already updated, so the picked theme still applies for
      // this page load even if persisting it for next time failed.
    }
  }

  function submit() {
    setError(null)
    setSaved(false)
    start(async () => {
      const result = await saveSettings({
        business_name: businessName,
        legal_name: legalName,
        address_line1: addressLine1,
        address_line2: addressLine2,
        phone,
        email,
        remit_to: remitTo,
        ach_details: achDetails,
        default_terms_days: Number(termsDays),
        next_invoice_number: Number(nextInvoiceNumber),
        tax_setaside_bp: taxSetasidePct.trim() === '' ? 0 : Math.round(Number(taxSetasidePct) * 100),
        monthly_take_home_cents:
          monthlyTakeHome.trim() === '' ? 0 : Math.round(Number(monthlyTakeHome) * 100),
        monthly_overhead_cents:
          monthlyOverhead.trim() === '' ? null : Math.round(Number(monthlyOverhead) * 100),
        billing_lag_days: billingLagDays.trim() === '' ? 7 : Number(billingLagDays),
      })
      if ('error' in result) { setError(result.error); return }
      setSaved(true)
      router.refresh()
    })
  }

  return (
    <div className="max-w-xl">
      <h1 className="display text-3xl font-bold mb-8">Settings</h1>

      <h2 className="eyebrow mb-3">Business</h2>
      <div className="grid gap-4 sm:grid-cols-2 mb-8">
        <div>
          <label className="eyebrow block mb-2" htmlFor="business-name">Trading name</label>
          <input id="business-name" className={FIELD_FULL} value={businessName}
                 onChange={(e) => setBusinessName(e.target.value)} />
        </div>

        <div>
          <label className="eyebrow block mb-2" htmlFor="legal-name">Legal name</label>
          <input id="legal-name" className={FIELD_FULL} value={legalName}
                 onChange={(e) => setLegalName(e.target.value)} />
          <p className="text-xs text-muted mt-1.5">Appears in the remit-to block.</p>
        </div>

        <div>
          <label className="eyebrow block mb-2" htmlFor="address1">Address</label>
          <input id="address1" className={FIELD_FULL} value={addressLine1}
                 placeholder="Line 1"
                 onChange={(e) => setAddressLine1(e.target.value)} />
        </div>

        <div>
          <label className="eyebrow block mb-2 sm:invisible" htmlFor="address2">Address 2</label>
          <input id="address2" className={FIELD_FULL} value={addressLine2}
                 placeholder="Line 2 (optional)"
                 onChange={(e) => setAddressLine2(e.target.value)} />
        </div>

        <div>
          <label className="eyebrow block mb-2" htmlFor="phone">Phone</label>
          <input id="phone" className={FIELD_FULL} value={phone}
                 onChange={(e) => setPhone(e.target.value)} />
        </div>

        <div>
          <label className="eyebrow block mb-2" htmlFor="email">Email</label>
          <input id="email" type="email" className={FIELD_FULL} value={email}
                 onChange={(e) => setEmail(e.target.value)} />
        </div>
      </div>

      <h2 className="eyebrow mb-3">Invoicing</h2>
      <div className="grid gap-4 sm:grid-cols-2 mb-8">
        <div>
          <label className="eyebrow block mb-2" htmlFor="next-number">Next invoice number</label>
          <input id="next-number" type="number" className={FIELD_FULL} value={nextInvoiceNumber}
                 onChange={(e) => setNextInvoiceNumber(e.target.value)} />
          <p className="text-xs text-muted mt-1.5">The spreadsheet ended at 388.</p>
        </div>

        <div>
          <label className="eyebrow block mb-2" htmlFor="terms">Default terms (days)</label>
          <input id="terms" type="number" min={0} className={FIELD_FULL} value={termsDays}
                 onChange={(e) => setTermsDays(e.target.value)} />
        </div>

        <div>
          <label className="eyebrow block mb-2" htmlFor="tax-setaside">Tax set-aside (%)</label>
          <input id="tax-setaside" type="number" min={0} max={100} step="0.25"
                 className={FIELD_FULL} value={taxSetasidePct} placeholder="e.g. 30"
                 onChange={(e) => setTaxSetasidePct(e.target.value)} />
          <p className="text-xs text-muted mt-1.5">
            Used only to estimate per-show take-home. Ask your CPA for the number;
            leave blank to skip the estimate.
          </p>
        </div>
      </div>

      <h2 className="eyebrow mb-3">Forecast</h2>
      <div className="grid gap-4 sm:grid-cols-2 mb-8">
        <div>
          <label className="eyebrow block mb-2" htmlFor="take-home">Monthly take-home</label>
          <input id="take-home" type="number" min={0} step="0.01" className={FIELD_FULL}
                 value={monthlyTakeHome} placeholder="e.g. 4500"
                 onChange={(e) => setMonthlyTakeHome(e.target.value)} />
        </div>

        <div>
          <label className="eyebrow block mb-2" htmlFor="overhead">Monthly overhead override</label>
          <input id="overhead" type="number" min={0} step="0.01" className={FIELD_FULL}
                 value={monthlyOverhead} placeholder="Blank uses the computed average"
                 onChange={(e) => setMonthlyOverhead(e.target.value)} />
          <p className="text-xs text-muted mt-1.5">
            Leave blank to use the trailing 3-month average instead of a fixed number.
          </p>
        </div>

        <div>
          <label className="eyebrow block mb-2" htmlFor="billing-lag">Billing lag (days)</label>
          <input id="billing-lag" type="number" min={0} max={120} className={FIELD_FULL}
                 value={billingLagDays}
                 onChange={(e) => setBillingLagDays(e.target.value)} />
          <p className="text-xs text-muted mt-1.5">Days from a show&rsquo;s last day to invoicing.</p>
        </div>
      </div>

      <h2 className="eyebrow mb-3">Payment</h2>
      <div className="mb-8">
        <div className="mb-4">
          <label className="eyebrow block mb-2" htmlFor="remit-to">Remit to</label>
          <textarea id="remit-to" rows={3} className={FIELD_FULL} value={remitTo}
                    onChange={(e) => setRemitTo(e.target.value)} />
          <p className="text-xs text-muted mt-1.5">Prints on every invoice.</p>
        </div>

        <div>
          <label className="eyebrow block mb-2" htmlFor="ach-details">ACH details</label>
          <textarea id="ach-details" rows={3} className={FIELD_FULL} value={achDetails}
                     onChange={(e) => setAchDetails(e.target.value)} />
          <p className="text-xs text-muted mt-1.5">
            Never printed on an invoice. A client who wants to pay by transfer asks, and you send
            these to them separately.
          </p>
        </div>
      </div>

      <h2 className="eyebrow mb-3">Preferences</h2>
      <div className="grid gap-4 sm:grid-cols-2 mb-8">
        <div>
          <label className="eyebrow block mb-2">Appearance</label>
          <Select
            ariaLabel="Appearance"
            value={appearance}
            onChange={onAppearanceChange}
            options={APPEARANCE_OPTIONS}
          />
          <p className="text-xs text-muted mt-1.5">This device only.</p>
        </div>
      </div>

      {error && (
        <p role="alert" className="mb-5 text-sm text-danger border-l-2 border-danger pl-3 py-1">
          {error}
        </p>
      )}
      {saved && !error && (
        <p className="mb-5 text-sm text-good">Saved.</p>
      )}

      <div className="flex items-center gap-3">
        <button type="button" onClick={submit} disabled={pending}
                className="px-5 py-2.5 bg-accent-surface text-accent-ink font-bold uppercase tracking-wider
                           text-sm rounded-field cursor-pointer hover:opacity-90 transition-opacity
                           disabled:opacity-50 disabled:cursor-not-allowed">
          {pending ? 'Saving…' : 'Save changes'}
        </button>
        <button type="button" onClick={() => router.back()} disabled={pending}
                className="px-5 py-2.5 border border-line text-muted font-bold uppercase tracking-wider
                           text-sm rounded-field cursor-pointer hover:text-ink transition-colors">
          Cancel
        </button>
      </div>
    </div>
  )
}
