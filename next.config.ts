import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // The invoice PDF is rendered server-side when an invoice is emailed, which
  // reads the font and the logo off the filesystem. public/ is a CDN concern
  // to Vercel and is not bundled into a function unless it is traced here.
  outputFileTracingIncludes: {
    '/invoices/[id]': ['./public/fonts/Oswald-Bold.ttf', './public/logo.png'],
  },
}

export default nextConfig
