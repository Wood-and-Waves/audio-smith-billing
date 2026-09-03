// TEMPORARY render instrumentation (2026-09-02). Dan reported the app feeling
// slow — button clicks and ledger entry lagging — and pg_stat_statements ruled
// the database out: every app query runs in 1-22ms. The suspicion is that the
// money pages await ~15-26 independent fetches ONE AT A TIME, so the cost is
// round trips, not work. This measures that directly in the only environment
// with a live database (production), because the DEV Supabase project no
// longer resolves.
//
// One stdout line per render, which Vercel captures as a runtime log. No
// behaviour change, no data in the log beyond durations and step names —
// nothing about the transactions themselves.
//
// Remove (or gate behind an env var) once the numbers are in.

export function perfTimer(label: string) {
  const t0 = Date.now()
  let last = t0
  const marks: string[] = []
  return {
    /** Time since the previous mark — i.e. what THIS step cost. */
    mark(name: string) {
      const now = Date.now()
      marks.push(`${name}=${now - last}`)
      last = now
    },
    done() {
      console.log(`[perf] ${label} TOTAL=${Date.now() - t0}ms | ${marks.join(' ')}`)
    },
    /**
     * Wraps one promise inside a Promise.all so its INDIVIDUAL duration is
     * recorded. Twelve genuinely parallel calls should all report roughly the
     * same elapsed time (they start together and the wave ends when the
     * slowest finishes); if instead they report a staircase, something is
     * serialising them and the wave is parallel in name only.
     */
    track<T>(name: string, p: PromiseLike<T>): Promise<T> {
      const start = Date.now()
      return Promise.resolve(p).then((v) => {
        marks.push(`${name}@${start - t0}+${Date.now() - start}`)
        return v
      })
    },
  }
}
