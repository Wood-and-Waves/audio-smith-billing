import { createClient } from '@/lib/supabase/server'
import AppShell from '@/components/AppShell'
import SettingsEditor, { type EditorSettings } from '@/components/SettingsEditor'

export const dynamic = 'force-dynamic'

export default async function SettingsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  // proxy.ts redirects an unauthenticated request to /login before it reaches
  // here, so this is belt and braces — but the owner filter below needs an id,
  // and silently passing `undefined` to .eq() is not a failure mode worth
  // finding out about on the Settings screen.
  if (!user) {
    return (
      <AppShell current="settings">
        <p role="alert" className="text-danger border-l-2 border-danger pl-4 py-2">
          You&rsquo;re not signed in.
        </p>
      </AppShell>
    )
  }

  const { data: s, error } = await supabase
    .from('settings')
    .select(
      `business_name, legal_name, address_line1, address_line2, phone, email,
       remit_to, ach_details, default_terms_days, next_invoice_number, tax_setaside_bp`,
    )
    // owner_id, not `id = 1`. This screen is the one that EDITS the letterhead
    // every invoice prints, so loading a row that is not the signed-in owner's
    // would hand their business details — including ach_details — to whoever
    // opened the page. One owner today, but nothing stops a second, so the
    // filter has to be here regardless of what RLS is doing underneath.
    .eq('owner_id', user.id)
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
