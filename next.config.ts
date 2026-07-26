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

  // ── Redirects ────────────────────────────────────────────────────────────
  async redirects() {
    return [
      // The inbox now renders at the bare root `/` (src/app/(app)/page.tsx).
      // Keep the old `/inbox` URL working with a permanent redirect so OAuth
      // callbacks, old bookmarks, and any external links still resolve.
      // `permanent: true` emits a 308 (the method-preserving permanent
      // redirect) and is cached by clients/search engines. Redirects run
      // before the filesystem + proxy, so a browser hitting `/inbox` is sent
      // to `/` before any page renders. (#58)
      {
        source: "/inbox",
        destination: "/",
        permanent: true,
      },

      // ── Legacy-domain 301 redirect (#54) ─────────────────────────────────
      // Permanently redirect every request arriving on the old domain
      // (dlectroflow.dlectronique.dev) to the canonical domain (dlectroflow.dev),
      // preserving the full path and query string via `:path*`.
      //
      // The `has` host condition matches only requests whose Host header equals
      // the legacy hostname, so canonical-domain traffic is unaffected.
      //
      // Infrastructure side: the legacy host is added to the PRIMARY ingress
      // (multi-SAN TLS cert in charts/dlectroflow/templates/ingress.yaml) so
      // TLS terminates correctly and the request reaches this app. The separate
      // ingress-legacy-redirect.yaml was removed — the ingress-nginx
      // `permanent-redirect` annotation cannot do a path-preserving cross-domain
      // redirect (it emits a literal `return 301 <url>;` with no $request_uri
      // appended, and the admission webhook rejects nginx variables post-CVE
      // hardening). Doing the redirect here is unit-testable and webhook-safe.
      {
        source: "/:path*",
        has: [
          {
            type: "host",
            value: "dlectroflow.dlectronique.dev",
          },
        ],
        destination: "https://dlectroflow.dev/:path*",
        permanent: true,
      },
    ];
  },

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
