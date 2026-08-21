import type { Metadata, Viewport } from 'next'
import { Inter, Oswald } from 'next/font/google'
import './globals.css'

const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' })
const oswald = Oswald({
  subsets: ['latin'],
  weight: ['500', '600', '700'],
  variable: '--font-oswald',
  display: 'swap',
})

export const metadata: Metadata = {
  title: 'Billing | The Audio Smith',
  description: 'Invoicing for Smith Audio, LLC.',
  robots: { index: false, follow: false },

  // Added to an iPhone home screen, iOS uses app/apple-icon.png. Without one
  // it screenshots the page instead — which is why a web app saved to a home
  // screen so often shows a thumbnail of whatever happened to be on screen.
  //
  // `capable` launches it without Safari's chrome, which on a show floor is
  // the difference between a URL bar and another row of punch buttons. The
  // status bar is solid black rather than translucent on purpose: with
  // `black-translucent` the page runs underneath it and the nav collides with
  // the clock.
  appleWebApp: {
    capable: true,
    title: 'Billing',
    statusBarStyle: 'black',
  },
}

// Tints the browser chrome on mobile. Both values must stay in sync with
// --bg in globals.css, or the chrome fights the app it frames.
//
// Deliberately still media-based, not theme-aware: this doesn't follow the
// per-device Appearance switch (data-theme), only the OS preference. Fixing
// that means a JS meta-updater running on toggle; accepted gap, tracked in
// docs/BACKLOG.md under Small/cosmetic.
export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f1f5f9' },
    { media: '(prefers-color-scheme: dark)', color: '#121212' },
  ],
}

// Reads the per-device theme choice (localStorage 'theme', written by the
// Appearance control in components/SettingsEditor.tsx) and stamps it onto
// <html> BEFORE first paint, so the page never flashes the wrong theme then
// snaps to the right one. This is the app's first inline script — safe only
// because next.config.ts's headers() deliberately ships no script-src CSP
// (a full CSP there would also break @react-pdf and Next's own inline
// bootstrap). Minified to one line on purpose; it runs pre-hydration.
const THEME_INIT_SCRIPT =
  "try{var t=localStorage.getItem('theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}"

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // suppressHydrationWarning: the script above sets data-theme on the
    // client before React hydrates, which would otherwise make React flag a
    // server/client markup mismatch on this element every load.
    <html lang="en" className={`${inter.variable} ${oswald.variable}`} suppressHydrationWarning>
      <head>
        {/* Must run in <head>, before <body> paints, or the pre-theme flash
            this exists to prevent happens anyway. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  )
}
