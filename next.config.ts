import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // The invoice PDF is rendered server-side when an invoice is emailed, which
  // reads the font and the logo off the filesystem. public/ is a CDN concern
  // to Vercel and is not bundled into a function unless it is traced here.
  outputFileTracingIncludes: {
    '/invoices/[id]': ['./public/fonts/Oswald-Bold.ttf', './public/logo.png'],
    '/i/[token]/pdf': ['./public/fonts/Oswald-Bold.ttf', './public/logo.png'],
  },
  // Baseline security headers on every response. frame-ancestors 'none' (plus
  // the legacy X-Frame-Options) is the clickjacking fix; this is deliberately
  // NOT a full CSP — a script/style CSP risks breaking @react-pdf, Next's
  // inline bootstrap scripts and the app's inline styles.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ]
  },
}

export default nextConfig
