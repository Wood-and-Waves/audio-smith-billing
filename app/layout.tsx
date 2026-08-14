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
export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f1f5f9' },
    { media: '(prefers-color-scheme: dark)', color: '#121212' },
  ],
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${oswald.variable}`}>
      <body>{children}</body>
    </html>
  )
}
