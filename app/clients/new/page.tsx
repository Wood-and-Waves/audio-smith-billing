import Link from 'next/link'
import AppShell from '@/components/AppShell'
import ClientEditor from '@/components/ClientEditor'

export const dynamic = 'force-dynamic'

export default function NewClientPage() {
  return (
    <AppShell current="clients">
      <Link
        href="/clients"
        className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-wider
                   text-muted hover:text-ink transition-colors mb-8"
      >
        ← All clients
      </Link>

      <ClientEditor />
    </AppShell>
  )
}
