import type { NextConfig } from "next";

// ── HTTP Security Headers ────────────────────────────────────────────────────
// Applied to every response. Satisfies OWASP ASVS V14.4 and provides a strong
// baseline for SOC 2 CC6.1 (logical access controls via transport security).
//
// CSP notes:
//   - 'unsafe-inline' on script-src is required by Next.js inline hydration
//     scripts. Tighten to a nonce-based policy once the app is stable.
//   - connect-src is scoped to only the external APIs this app actually calls.
const securityHeaders = [
  // Prevent browsers from MIME-sniffing the content-type (OWASP A05)
  { key: "X-Content-Type-Options", value: "nosniff" },

  // Block the app from being embedded in iframes (clickjacking defence).
  // DENY to match CSP `frame-ancestors 'none'` below — the app is never framed.
  { key: "X-Frame-Options", value: "DENY" },

  // Enforce HTTPS for 2 years, include subdomains, allow preload submission
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },

  // Control referrer information sent to third parties
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },

  // Disable browser features not used by this app
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=()",
  },

  // Enable DNS prefetching for performance (safe — no privacy risk here)
  { key: "X-DNS-Prefetch-Control", value: "on" },

  // Content Security Policy
  // Restricts resource loading to trusted origins only.
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      // Next.js requires unsafe-inline for its inline hydration scripts.
      // TODO: migrate to nonce-based CSP when Next.js nonce support stabilises.
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      // Typefaces (Figtree, Atkinson Hyperlegible, Geist Mono, OpenDyslexic)
      // are self-hosted at build time via next/font — no third-party requests.
      "font-src 'self' data:",
      "img-src 'self' data: blob:",
      // External APIs this app calls server-side (proxied) or client-side (OAuth).
      [
        "connect-src 'self'",
        "https://api.anthropic.com",
        "https://tasks.googleapis.com",
        "https://accounts.google.com",
        "https://oauth2.googleapis.com",
      ].join(" "),
      // Disallow all framing (belt-and-suspenders with X-Frame-Options)
      "frame-ancestors 'none'",
      // Disallow plugins (Flash etc.)
      "object-src 'none'",
      // Restrict base tag hijacking
      "base-uri 'self'",
      // Restrict form submissions to same origin
      "form-action 'self'",
    ].join("; "),
  },
];

const nextConfig: NextConfig = {
  output: "standalone",

  // Attach security headers to every route.
  async headers() {
    return [
      {
        // Match all routes including API routes, static files, etc.
        source: "/(.*)",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
