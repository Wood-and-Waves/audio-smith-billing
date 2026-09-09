'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'

/**
 * Sets (or clears) the draw Dan plans for one month. Clearing means "the
 * usual" — the month falls back to settings.monthly_take_home_cents — which
 * is why null is a real argument and not just an empty string.
 */
export async function setDrawPlan(
  month: string, amountCents: number | null,
): Promise<{ ok: true } | { error: string }> {
  if (!/^\d{4}-\d{2}$/.test(month)) return { error: 'That is not a month.' }
  if (amountCents !== null && (!Number.isInteger(amountCents) || amountCents < 0)) {
    return { error: 'A planned draw cannot be negative.' }
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not signed in.' }

  if (amountCents === null) {
    const { error } = await supabase
      .from('forecast_draw_plans').delete().eq('owner_id', user.id).eq('month', `${month}-01`)
    if (error) return { error: error.message }
  } else {
    const { error } = await supabase
      .from('forecast_draw_plans')
      .upsert(
        { owner_id: user.id, month: `${month}-01`, amount_cents: amountCents, updated_at: new Date().toISOString() },
        { onConflict: 'owner_id,month' },
      )
    if (error) return { error: error.message }
  }

  revalidatePath('/money/forecast')
  return { ok: true }
}
