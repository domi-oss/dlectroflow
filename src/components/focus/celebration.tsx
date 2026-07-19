"use client";

import { motion } from "motion/react";
import { usePrefersReducedMotion } from "@/lib/use-prefers-reduced-motion";

const EMOJIS = ["🎉", "✨", "⭐", "🎊", "💫", "🌟", "🥳"];

/**
 * A one-shot confetti-ish burst of emoji particles (Motion, née Framer Motion).
 *
 * Non-essential decoration: when the OS "reduce motion" setting is on we render
 * nothing at all — no particle burst — so motion-sensitive users get the static
 * reward (the 🎉 + message the focus screen shows alongside this) without the
 * flying/scaling particles (a11y: prefers-reduced-motion).
 */
export function Celebration() {
  const reduced = usePrefersReducedMotion();
  if (reduced) return null;

  const particles = Array.from({ length: 16 });
  return (
    <div aria-hidden className="pointer-events-none relative mx-auto h-0 w-0">
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
