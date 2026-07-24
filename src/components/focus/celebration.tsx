"use client";

import { motion } from "motion/react";
import { usePrefersReducedMotion } from "@/lib/use-prefers-reduced-motion";

const EMOJIS = ["🎉", "✨", "⭐", "🎊", "💫", "🌟", "🥳"];

/**
 * A one-shot confetti-ish burst of emoji particles (Motion, née Framer Motion)
 * behind a brief neon gradient flash — a short dopamine hit on completion
 * (#40 Phase 3.2).
 *
 * Non-essential decoration: when the OS "reduce motion" setting is on we render
 * nothing at all — no particle burst, no flash — so motion-sensitive users get
 * the static reward (the 🎉 + message the focus screen shows alongside this)
 * without the flying/scaling particles (a11y: prefers-reduced-motion). The green
 * "done" semantic tick lives elsewhere (done-pill) and is deliberately untouched.
 */
export function Celebration() {
  const reduced = usePrefersReducedMotion();
  if (reduced) return null;

  const particles = Array.from({ length: 16 });
  return (
    <div aria-hidden className="pointer-events-none relative mx-auto h-0 w-0">
      {/* Neon gradient flash — the brand dopamine burst (a <div>, not a
          particle <span>, so it never counts as an emoji particle). */}
      <motion.div
        data-testid="celebration-flash"
        className="absolute left-0 top-0 h-40 w-40 -translate-x-1/2 -translate-y-1/2 rounded-full blur-xl [background:radial-gradient(circle,var(--color-brand-pink),var(--color-brand-magenta)_45%,transparent_70%)]"
        initial={{ opacity: 0.75, scale: 0.3 }}
        animate={{ opacity: 0, scale: 2.2 }}
        transition={{ duration: 0.7, ease: "easeOut" }}
      />
      {particles.map((_, i) => {
        const angle = (i / particles.length) * Math.PI * 2;
        const dist = 70 + ((i * 37) % 70);
        return (
          <motion.span
            key={i}
            className="absolute text-2xl"
            initial={{ opacity: 1, x: 0, y: 0, scale: 0.4 }}
            animate={{
              opacity: 0,
              x: Math.cos(angle) * dist,
              y: Math.sin(angle) * dist - 30,
              scale: 1.2,
              rotate: (i % 2 ? 1 : -1) * 90,
            }}
            transition={{ duration: 1.1, ease: "easeOut" }}
          >
            {EMOJIS[i % EMOJIS.length]}
          </motion.span>
        );
      })}
    </div>
  );
}
