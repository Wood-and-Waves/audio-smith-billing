import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import AppShell from '@/components/AppShell'
import CategoryEditor, { type CategoryRow } from '@/components/CategoryEditor'

export const dynamic = 'force-dynamic'

function LoadError({ message }: { message: string }) {
  return (
    <AppShell current="money">
      <p role="alert" className="text-danger border-l-2 border-danger pl-4 py-2">
        Couldn&rsquo;t load categories: {message}
      </p>
    </AppShell>
  )
}

export default async function MoneyCategoriesPage() {
  const supabase = await createClient()

  // Every category, including hidden ones — this screen is the only place a
  // hidden category can ever be found and un-hidden again, so unlike the
  // register's own category query (app/money/page.tsx, `.eq('hidden',
  // false)`) there is no filter here at all.
  const { data, error } = await supabase
    .from('ledger_categories')
    .select('id, name, grp, sort, hidden, is_equipment, deductible, budget_role')
    .order('grp', { ascending: true })
    .order('sort', { ascending: true })
    .order('name', { ascending: true })
  if (error) return <LoadError message={error.message} />

  const categories: CategoryRow[] = (data ?? []).map((c) => ({
    id: c.id,
    name: c.name,
    grp: c.grp,
    sort: c.sort,
    hidden: c.hidden,
    isEquipment: c.is_equipment,
    deductible: c.deductible,
    budgetRole: c.budget_role as 'spending' | 'income',
  }))

  return (
    <AppShell current="money">
      <Link
        href="/money"
        className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-wider
                   text-muted hover:text-ink transition-colors mb-8"
      >
        ← Back to the ledger
      </Link>

      <h1 className="display text-3xl font-bold mb-8">Categories</h1>

      <CategoryEditor categories={categories} />
    </AppShell>
  )
}
