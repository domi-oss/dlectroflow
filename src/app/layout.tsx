import type { Metadata } from "next";
import { Figtree, Atkinson_Hyperlegible, Geist_Mono } from "next/font/google";
import { openDyslexic } from "@/fonts/opendyslexic";
import { THEME_BOOTSTRAP_SCRIPT } from "@/lib/theme";
import { ThemeSync } from "@/components/theme-sync";
import "./globals.css";

const figtree = Figtree({
  variable: "--font-figtree",
  subsets: ["latin"],
});

const atkinson = Atkinson_Hyperlegible({
  variable: "--font-atkinson",
  subsets: ["latin"],
  weight: ["400", "700"],
  preload: false,
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "dlectroflow",
  description:
    "An ADHD helper: capture, clarify, schedule, focus, and get rewarded.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${figtree.variable} ${atkinson.variable} ${openDyslexic.variable} ${geistMono.variable} h-full antialiased`}
    >
      <head>
        {/* #85 — the anti-FOUC bootstrap. It now resolves the THREE-state
            setting (system / light / dark, defaulting to system) and consults
            `prefers-color-scheme`, so a first visit on a dark device paints dark
            instead of flashing the light default. The script source lives in
            @/lib/theme so it is built from the same constants the components
            read and can be executed by a test — see theme.test.ts, which runs
            this exact string against every stored value × both OS settings.
            `suppressHydrationWarning` on <html> above is what lets it write to
            the element the server rendered (#75). */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP_SCRIPT }} />
      </head>
      <body className="min-h-full flex flex-col">
        {/* #85 — keeps `system` LIVE: switch the OS appearance (or let its own
            day/night schedule do it) and the app follows without a reload. In
            the root layout rather than in the header, because /login, /privacy
            and /terms render outside the (app) group and so have no header. */}
        <ThemeSync />
        {children}
      </body>
    </html>
  );
}
