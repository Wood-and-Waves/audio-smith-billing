import { createClient } from '@/lib/supabase/server'
import AppShell from '@/components/AppShell'
import SettingsEditor, { type EditorSettings } from '@/components/SettingsEditor'

export const dynamic = 'force-dynamic'

export default async function SettingsPage() {
  const supabase = await createClient()

  const { data: s, error } = await supabase
    .from('settings')
    .select(
      `business_name, legal_name, address_line1, address_line2, phone, email,
       remit_to, ach_details, default_terms_days, default_tax_bp, next_invoice_number`,
    )
    .eq('id', 1)
    .maybeSingle()

  if (error) {
    return (
      <AppShell current="settings">
        <p role="alert" className="text-danger border-l-2 border-danger pl-4 py-2">
          Couldn&rsquo;t load settings: {error.message}
        </p>
      </AppShell>
    )
  }

  if (!s) {
    return (
      <AppShell current="settings">
        <p role="alert" className="text-danger border-l-2 border-danger pl-4 py-2">
          No settings row found.
        </p>
      </AppShell>
    )
  }

  return (
    <AppShell current="settings">
      <SettingsEditor initial={s as unknown as EditorSettings} />
    </AppShell>
  )
}
