import type { MetadataRoute } from 'next'

// Served at /manifest.webmanifest, which proxy.ts excludes BY NAME in its
// matcher — the extension list does not cover it, and without that exclusion
// the middleware answers it with a 307 and the install silently degrades.
//
// `display: standalone` is what makes this open without Safari's chrome when
// launched from the home screen. That also removes the browser back button, so
// it relies on the app's own navigation — AppShell's nav plus the per-screen
// back links, which every screen has.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'The Audio Smith — Billing',
    // What appears under the icon. Short: iOS truncates around 12 characters.
    short_name: 'Billing',
    description: 'Invoicing and show tracking for Smith Audio, LLC.',
    start_url: '/invoices',
    display: 'standalone',
    // Both match --bg in globals.css, the same value the theme-colour meta
    // uses. A splash or status bar in a different charcoal reads as a bug.
    background_color: '#121212',
    theme_color: '#121212',
    icons: [
      {
        // Full-bleed amber, so Android can crop it to whatever mask the
        // launcher uses without eating the microphone.
        src: '/icon-maskable.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
      {
        src: '/logo.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any',
      },
    ],
  }
}
