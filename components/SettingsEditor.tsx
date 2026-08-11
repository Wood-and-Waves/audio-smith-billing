'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { saveSettings } from '@/app/settings/actions'

const field =
  'w-full px-3 py-2 bg-surface border border-line rounded-field text-ink text-sm ' +
  'focus:border-accent focus:outline-none'

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
  default_tax_bp: number
  next_invoice_number: number
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
  const [taxPct, setTaxPct] = useState(
    initial.default_tax_bp ? String(initial.default_tax_bp / 100) : '',
  )

  const [remitTo, setRemitTo] = useState(initial.remit_to ?? '')
  const [achDetails, setAchDetails] = useState(initial.ach_details ?? '')

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
        default_tax_pct: taxPct,
        next_invoice_number: Number(nextInvoiceNumber),
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
          <input id="business-name" className={field} value={businessName}
                 onChange={(e) => setBusinessName(e.target.value)} />
        </div>

        <div>
          <label className="eyebrow block mb-2" htmlFor="legal-name">Legal name</label>
          <input id="legal-name" className={field} value={legalName}
                 onChange={(e) => setLegalName(e.target.value)} />
          <p className="text-xs text-muted mt-1.5">Appears in the remit-to block.</p>
        </div>

        <div>
          <label className="eyebrow block mb-2" htmlFor="address1">Address</label>
          <input id="address1" className={field} value={addressLine1}
                 placeholder="Line 1"
                 onChange={(e) => setAddressLine1(e.target.value)} />
        </div>

        <div>
          <label className="eyebrow block mb-2 sm:invisible" htmlFor="address2">Address 2</label>
          <input id="address2" className={field} value={addressLine2}
                 placeholder="Line 2 (optional)"
                 onChange={(e) => setAddressLine2(e.target.value)} />
        </div>

        <div>
          <label className="eyebrow block mb-2" htmlFor="phone">Phone</label>
          <input id="phone" className={field} value={phone}
                 onChange={(e) => setPhone(e.target.value)} />
        </div>

        <div>
          <label className="eyebrow block mb-2" htmlFor="email">Email</label>
          <input id="email" type="email" className={field} value={email}
                 onChange={(e) => setEmail(e.target.value)} />
        </div>
      </div>

      <h2 className="eyebrow mb-3">Invoicing</h2>
      <div className="grid gap-4 sm:grid-cols-2 mb-8">
        <div>
          <label className="eyebrow block mb-2" htmlFor="next-number">Next invoice number</label>
          <input id="next-number" type="number" className={field} value={nextInvoiceNumber}
                 onChange={(e) => setNextInvoiceNumber(e.target.value)} />
          <p className="text-xs text-muted mt-1.5">The spreadsheet ended at 388.</p>
        </div>

        <div>
          <label className="eyebrow block mb-2" htmlFor="terms">Default terms (days)</label>
          <input id="terms" type="number" min={0} className={field} value={termsDays}
                 onChange={(e) => setTermsDays(e.target.value)} />
        </div>

        <div className="sm:col-span-2">
          <label className="eyebrow block mb-2" htmlFor="tax">Default tax (%)</label>
          <input id="tax" inputMode="decimal" placeholder="e.g. 8.25" className={field}
                 value={taxPct} onChange={(e) => setTaxPct(e.target.value)} />
          <p className="text-xs text-muted mt-1.5">
            Zero on all 105 invoices to date. The tax line is hidden on an invoice unless it&rsquo;s set.
          </p>
        </div>
      </div>

      <h2 className="eyebrow mb-3">Payment</h2>
      <div className="mb-8">
        <div className="mb-4">
          <label className="eyebrow block mb-2" htmlFor="remit-to">Remit to</label>
          <textarea id="remit-to" rows={3} className={field} value={remitTo}
                    onChange={(e) => setRemitTo(e.target.value)} />
          <p className="text-xs text-muted mt-1.5">Prints on every invoice.</p>
        </div>

        <div>
          <label className="eyebrow block mb-2" htmlFor="ach-details">ACH details</label>
          <textarea id="ach-details" rows={3} className={field} value={achDetails}
                     onChange={(e) => setAchDetails(e.target.value)} />
          <p className="text-xs text-muted mt-1.5">
            Never printed on an invoice. A client who wants to pay by transfer asks, and you send
            these to them separately.
          </p>
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
                className="px-5 py-2.5 bg-accent text-accent-ink font-bold uppercase tracking-wider
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
