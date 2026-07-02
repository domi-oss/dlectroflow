const LOOP = ["🧠 Capture", "✂️ Clarify", "📅 Schedule", "⏱️ Focus", "🎉 Reward"];

export default function Home() {
  return (
    <main className="mx-auto flex min-h-full w-full max-w-2xl flex-col justify-center gap-8 px-6 py-16">
      <header className="space-y-2">
        <h1 className="text-4xl font-semibold tracking-tight">dlectroflow</h1>
        <p className="text-muted-foreground text-lg">
          An ADHD helper — capture, clarify, schedule, focus, and get rewarded.
        </p>
      </header>

      <ol className="flex flex-wrap items-center gap-2 text-sm">
        {LOOP.map((step, i) => (
          <li key={step} className="flex items-center gap-2">
            <span className="bg-secondary text-secondary-foreground rounded-full px-3 py-1 font-medium">
              {step}
            </span>
            {i < LOOP.length - 1 && <span className="text-muted-foreground">→</span>}
          </li>
        ))}
      </ol>

      <p className="text-muted-foreground text-sm">
        Scaffolding is in place. Features land next: Brain Dump, Task Breakdown → Reclaim,
        Focus Timer, and Rewards &amp; Streaks.
      </p>
    </main>
  );
}
