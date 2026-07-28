/**
 * Flavour text for the locked "Fable 5" decoy in the breakdown-model picker.
 *
 * Lives in its own module, NOT in settings-panel.tsx, because the line is rolled
 * on the server and passed to that client component as a prop: exports of a
 * `"use client"` module are client references, so calling one during a server
 * render fails outright ("Attempted to call randomFableLine() from the server").
 */
export const FABLE_LINES = [
  "Our most capable model. Also $50/M tokens. To split 'clean the kitchen' into 3 steps? We love you, but no.",
  "We tried it. It wrote a dissertation on the philosophy of procrastination instead of your task. Disabled for everyone's safety.",
  "Reserved for problems harder than 'remember to buy milk.' 💸",
  "Bringing a frontier reasoning model to a to-do list felt… irresponsible.",
  "It kept trying to solve P vs NP instead of your laundry. Locked.",
  "Overkill detector tripped. Fable stays in its cage for this one.",
];

/**
 * Pick a decoy line. Call this from the SERVER and pass the result down, never
 * during a client render: choosing it in a `useState` initialiser meant the
 * server and the client rolled different lines, so every /settings load was a
 * hydration mismatch. React resolves that by discarding and re-rendering the
 * tree — which reset `<html>`'s class list and silently dropped dark mode on
 * this page (light-mode screenshots of a "dark mode" run, and worse for anyone
 * who actually uses it).
 */
export function randomFableLine(): string {
  return FABLE_LINES[Math.floor(Math.random() * FABLE_LINES.length)];
}
