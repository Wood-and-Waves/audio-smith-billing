'use client'

import { useState, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Image from 'next/image'
import { createClient } from '@/lib/supabase/client'
import { readableAuthError } from '@/lib/authError'

function LoginForm() {
  const router = useRouter()
  const params = useSearchParams()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function signIn(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const supabase = createClient()
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) {
      setError(readableAuthError(error))
      setBusy(false)
      return
    }
    router.push(params.get('next') || '/invoices')
    router.refresh()
  }

  return (
    <form onSubmit={signIn} className="w-full max-w-sm">
      <Image
        src="/logo.png"
        alt=""
        width={64}
        height={64}
        className="mb-8"
        priority
      />

      <h1 className="display text-3xl font-bold mb-1">Billing</h1>
      <p className="text-muted text-sm mb-8">Smith Audio, LLC</p>

      <label className="eyebrow block mb-2" htmlFor="email">Email</label>
      <input
        id="email"
        type="email"
        autoComplete="username"
        required
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        className="w-full mb-5 px-4 py-3 bg-surface border border-line rounded-field text-ink
                   focus:border-accent focus:outline-none"
      />

      <label className="eyebrow block mb-2" htmlFor="password">Password</label>
      <input
        id="password"
        type="password"
        autoComplete="current-password"
        required
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        className="w-full mb-6 px-4 py-3 bg-surface border border-line rounded-field text-ink
                   focus:border-accent focus:outline-none"
      />

      {error && (
        <p role="alert" className="mb-5 text-sm text-danger border-l-2 border-danger pl-3">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={busy}
        className="w-full py-3 bg-accent-surface text-accent-ink font-bold uppercase tracking-wider
                   rounded-field cursor-pointer transition-opacity hover:opacity-90
                   disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  )
}

export default function LoginPage() {
  return (
    <main className="min-h-dvh flex items-center justify-center px-6 py-16">
      <Suspense>
        <LoginForm />
      </Suspense>
    </main>
  )
}
