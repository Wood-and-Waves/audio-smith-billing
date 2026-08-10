import { createClient } from '@/lib/supabase/server'
import AppShell from '@/components/AppShell'

export const dynamic = 'force-dynamic'

function Field({ label, value, hint }: { label: string; value: string | null; hint?: string }) {
  return (
    <div className="border-b border-line py-4">
      <dt className="eyebrow mb-1">{label}</dt>
      <dd className={value ? 'whitespace-pre-line' : 'text-muted italic'}>{value || 'Not set'}</dd>
      {hint && <p className="text-xs text-muted mt-1.5">{hint}</p>}
    </div>
  )
}

export default async function SettingsPage() {
  const supabase = await createClient()

  const { data: s, error } = await supabase.from('settings').select('*').eq('id', 1).maybeSingle()

  if (error) {
    return (
      <AppShell current="settings">
        <p role="alert" className="text-danger border-l-2 border-danger pl-4 py-2">
          Couldn&rsquo;t load settings: {error.message}
        </p>
      </AppShell>
    )
  }

  return (
    <AppShell current="settings">
      <h2 className="eyebrow mb-4">Business</h2>
      <dl className="border-t border-line mb-12">
        <Field label="Trading name" value={s?.business_name ?? null} />
        <Field label="Legal name" value={s?.legal_name ?? null} hint="Appears in the remit-to block." />
        <Field
          label="Address"
          value={[s?.address_line1, s?.address_line2].filter(Boolean).join('\n') || null}
        />
        <Field label="Phone" value={s?.phone ?? null} />
        <Field label="Email" value={s?.email ?? null} />
      </dl>

      <h2 className="eyebrow mb-4">Invoicing</h2>
      <dl className="border-t border-line mb-12">
        <Field
          label="Next invoice number"
          value={s ? String(s.next_invoice_number) : null}
          hint="The spreadsheet ended at 388."
        />
        <Field label="Default terms" value={s ? `Net ${s.default_terms_days}` : null} />
        <Field
          label="Default tax"
          value={s ? `${(s.default_tax_bp / 100).toFixed(2)}%` : null}
          hint="Zero on all 105 invoices to date. The tax line is hidden on an invoice unless it's set."
        />
      </dl>

      <h2 className="eyebrow mb-4">Payment</h2>
      <dl className="border-t border-line">
        <Field
          label="Remit to"
          value={s?.remit_to ?? null}
          hint="Prints on every invoice."
        />
        <Field
          label="ACH details"
          value={s?.ach_details ? 'Set — never printed' : null}
          hint="Deliberately kept off the PDF. A client who wants to pay by transfer asks, and you send them separately. The values aren't shown here either."
        />
      </dl>

      <p className="text-sm text-muted mt-10 border-l-2 border-line pl-4 py-1">
        These are read-only for now. Editing lands with the invoice editor, so
        there&rsquo;s one way to change things rather than two.
      </p>
    </AppShell>
  )
}
