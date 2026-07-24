// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FocusTimer } from "@/components/focus/focus-timer";
import type { TrackerStep } from "@/components/focus/focus-step-tracker";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh }),
}));
vi.mock("next/link", () => ({
  default: ({
    children,
    href,
  }: {
    children: React.ReactNode;
    href: string;
  }) => <a href={href}>{children}</a>,
}));

vi.mock("@/app/actions/focus", () => ({
  beginFocus: vi.fn().mockResolvedValue("session-1"),
  completeFocus: vi.fn().mockResolvedValue({
    ok: true,
    nextStepId: null,
    points: 15,
    googleSynced: false,
    streak: 1,
    freshStart: false,
  }),
  requeueFocus: vi.fn().mockResolvedValue({ ok: true }),
  proposeNewEstimate: vi.fn().mockResolvedValue(20),
}));
vi.mock("@/app/actions/settings", () => ({
  dismissFocusTimerTip: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/use-prefers-reduced-motion", () => ({
  usePrefersReducedMotion: () => false,
}));
// The Celebration confetti isn't under test here.
vi.mock("@/components/focus/celebration", () => ({
  Celebration: () => <div />,
}));

// Voice is controlled per-test via this mutable ref.
let mockVoice: "plain" | "playful" = "plain";
vi.mock("@/components/voice-provider", () => ({ useVoice: () => mockVoice }));

// Device-effect boundary — assert calls, never touch real APIs.
const alarmPlay = vi.fn();
const loop = { play: vi.fn(), pause: vi.fn(), stop: vi.fn() };
const wakeRelease = vi.fn();
const createAlarm = vi.fn((..._args: unknown[]) => ({ play: alarmPlay }));
const createLoopPlayer = vi.fn((..._args: unknown[]) => loop);
const acquireWakeLock = vi.fn((..._args: unknown[]) =>
  Promise.resolve({ release: wakeRelease }),
);
vi.mock("@/lib/focus-sounds", () => ({
  createAlarm: (...a: unknown[]) => createAlarm(...a),
  createLoopPlayer: (...a: unknown[]) => createLoopPlayer(...a),
  acquireWakeLock: (...a: unknown[]) => acquireWakeLock(...a),
  FOCUS_SOUND_SRC: { off: null, lofi_calm: "/audio/lofi-calm.mp3" },
}));

import { beginFocus, completeFocus } from "@/app/actions/focus";
import { dismissFocusTimerTip } from "@/app/actions/settings";

const STEPS: TrackerStep[] = [
  { id: "s1", text: "Outline", done: true, estMinutes: 5, subtaskEmoji: null },
  {
    id: "s2",
    text: "Draft intro",
    done: false,
    estMinutes: 1,
    subtaskEmoji: null,
  },
  { id: "s3", text: "Polish", done: false, estMinutes: 10, subtaskEmoji: null },
];

function base(overrides: Partial<Parameters<typeof FocusTimer>[0]> = {}) {
  return {
    step: {
      id: "s2",
      text: "Draft intro",
      estMinutes: 1,
      subtaskEmoji: null,
      order: 2,
      total: 3,
      done: false,
    },
    steps: STEPS,
    taskId: "t1",
    taskTitle: "Write report",
    parentEmoji: null,
    streak: 4,
    focusMinToday: 30,
    nextStep: { id: "s3", text: "Polish", subtaskEmoji: null },
    isSingleTask: false,
    addTimeIncrementMin: 5,
    settings: {
      timerStyle: null,
      minimalMode: false,
      keepAwake: true,
      alarmEnabled: true,
      sound: "off",
    },
    tipDismissed: false,
    ...overrides,
  } as Parameters<typeof FocusTimer>[0];
}

async function start(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /start focusing/i }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockVoice = "plain";
});
afterEach(cleanup);

describe("FocusTimer — header, back, hierarchy", () => {
  it("← Back links to /focus (no server call to leave — session stays open)", () => {
    render(<FocusTimer {...base()} />);
    expect(screen.getByRole("link", { name: /back/i })).toHaveAttribute(
      "href",
      "/focus",
    );
  });

  it("the setup 'Start focusing' CTA uses the brand gradient (hero neon signature)", () => {
    render(<FocusTimer {...base()} />);
    const startBtn = screen.getByRole("button", { name: /start focusing/i });
    expect(startBtn.className).toContain(
      "[background-image:var(--gradient-brand)]",
    );
    expect(startBtn.className).toContain("font-bold");
  });

  it("the active step text is larger (text-xl) than the task title (text-sm)", () => {
    render(<FocusTimer {...base()} />);
    const stepHeading = screen.getByRole("heading", { name: /draft intro/i });
    expect(stepHeading.className).toMatch(/text-xl/);
    expect(screen.getByText("Write report").className).toMatch(/text-sm/);
  });

  it("single-task focus shows the task title ONCE (no duplicate step-title line)", () => {
    // Single-task = the auto-created ensureFocusStep step, so step.text === taskTitle.
    render(
      <FocusTimer
        {...base({
          isSingleTask: true,
          taskTitle: "Call the bank",
          step: {
            id: "s1",
            text: "Call the bank",
            estMinutes: 10,
            subtaskEmoji: null,
            order: 1,
            total: 1,
            done: false,
          },
          steps: [
            {
              id: "s1",
              text: "Call the bank",
              done: false,
              estMinutes: 10,
              subtaskEmoji: null,
            },
          ],
          nextStep: null,
        })}
      />,
    );
    // The title must render exactly once (not task-context <p> AND step <h1>).
    expect(screen.getAllByText("Call the bank")).toHaveLength(1);
    // …and it stays the primary accessible heading.
    const heading = screen.getByRole("heading", { name: /call the bank/i });
    expect(heading.tagName).toBe("H1");
    expect(heading.className).toMatch(/text-xl/);
  });

  it("multi-step focus keeps the task title + active-step hierarchy", () => {
    render(<FocusTimer {...base()} />); // isSingleTask: false
    // Task title as smaller context…
    expect(screen.getByText("Write report").className).toMatch(/text-sm/);
    // …and the active step as the primary heading.
    expect(
      screen.getByRole("heading", { name: /draft intro/i }).className,
    ).toMatch(/text-xl/);
  });

  it("shows the corner streak + minutes today", () => {
    render(<FocusTimer {...base()} />);
    expect(screen.getByText(/🔥4/)).toBeInTheDocument();
    expect(screen.getByText(/30m today/)).toBeInTheDocument();
  });

  it("has NO 'Pause for now' control and never reaches a 'Paused — no guilt' screen", async () => {
    const user = userEvent.setup();
    render(<FocusTimer {...base()} />);
    await start(user);
    expect(
      screen.queryByRole("button", { name: /pause for now/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/no guilt/i)).not.toBeInTheDocument();
  });
});

describe("FocusTimer — style resolution", () => {
  it("defaults to ring in plain voice", () => {
    render(<FocusTimer {...base()} />);
    expect(screen.getByTestId("timer-visual-ring")).toBeInTheDocument();
  });
  it("defaults to mug in playful voice", () => {
    mockVoice = "playful";
    render(<FocusTimer {...base()} />);
    expect(screen.getByTestId("timer-visual-mug")).toBeInTheDocument();
  });
  it("honours an explicit stored style", () => {
    render(
      <FocusTimer
        {...base({
          settings: {
            timerStyle: "digits",
            minimalMode: false,
            keepAwake: true,
            alarmEnabled: true,
            sound: "off",
          },
        })}
      />,
    );
    expect(screen.getByTestId("timer-visual-digits")).toBeInTheDocument();
  });
});

describe("FocusTimer — ±time with clamp + signed note", () => {
  it("+5m shows a +5m net note; the − button is present", async () => {
    const user = userEvent.setup();
    render(
      <FocusTimer
        {...base({
          step: {
            id: "s2",
            text: "Draft intro",
            estMinutes: 10,
            subtaskEmoji: null,
            order: 2,
            total: 3,
            done: false,
          },
        })}
      />,
    );
    await start(user);
    await user.click(screen.getByRole("button", { name: /\+5m/i }));
    // The signed net note is a <p>; scope the match to it so the "+5m" button
    // (which also reads "+5m") doesn't make the query ambiguous.
    expect(screen.getByText(/\+5m/, { selector: "p" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /−5m|-5m/i }),
    ).toBeInTheDocument();
  });
});

describe("FocusTimer — multi-step context + minimal mode", () => {
  it("shows the step tracker + next-step peek for a multi-step task", () => {
    render(<FocusTimer {...base()} />);
    expect(screen.getByRole("button", { name: /steps/i })).toBeInTheDocument();
    expect(screen.getByText(/next →/)).toBeInTheDocument();
  });

  it("hides the multi-step context for single-task focus", () => {
    render(<FocusTimer {...base({ isSingleTask: true })} />);
    expect(
      screen.queryByRole("button", { name: /steps/i }),
    ).not.toBeInTheDocument();
  });

  it("auto-expands the tracker on pause", async () => {
    const user = userEvent.setup();
    render(<FocusTimer {...base()} />);
    await start(user);
    await user.click(screen.getByRole("button", { name: /pause/i }));
    expect(screen.getByRole("button", { name: /steps/i })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("minimal mode hides the tracker + corner while running", async () => {
    const user = userEvent.setup();
    render(
      <FocusTimer
        {...base({
          settings: {
            timerStyle: null,
            minimalMode: true,
            keepAwake: false,
            alarmEnabled: false,
            sound: "off",
          },
        })}
      />,
    );
    await start(user);
    expect(
      screen.queryByRole("button", { name: /steps/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/today/)).not.toBeInTheDocument();
  });
});

describe("FocusTimer — first-run hint gating", () => {
  it("shows the hint when not dismissed; ✕ calls dismissFocusTimerTip and hides it", async () => {
    const user = userEvent.setup();
    render(<FocusTimer {...base({ tipDismissed: false })} />);
    expect(screen.getByText(/make this timer yours/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(dismissFocusTimerTip).toHaveBeenCalled();
    expect(
      screen.queryByText(/make this timer yours/i),
    ).not.toBeInTheDocument();
  });

  it("hides the hint when already dismissed", () => {
    render(<FocusTimer {...base({ tipDismissed: true })} />);
    expect(
      screen.queryByText(/make this timer yours/i),
    ).not.toBeInTheDocument();
  });
});

describe("FocusTimer — device effects behind the boundary", () => {
  it("primes alarm + acquires the wake lock on Start when enabled; no loop when sound is off", async () => {
    const user = userEvent.setup();
    render(<FocusTimer {...base()} />);
    await start(user);
    expect(beginFocus).toHaveBeenCalledWith("s2", 1);
    expect(createAlarm).toHaveBeenCalled();
    expect(acquireWakeLock).toHaveBeenCalled();
    expect(createLoopPlayer).not.toHaveBeenCalled();
  });

  it("does NOT prime alarm / wake lock / loop when all are disabled", async () => {
    const user = userEvent.setup();
    render(
      <FocusTimer
        {...base({
          settings: {
            timerStyle: null,
            minimalMode: false,
            keepAwake: false,
            alarmEnabled: false,
            sound: "off",
          },
        })}
      />,
    );
    await start(user);
    expect(createAlarm).not.toHaveBeenCalled();
    expect(acquireWakeLock).not.toHaveBeenCalled();
    expect(createLoopPlayer).not.toHaveBeenCalled();
  });

  it("starts the lofi loop when a sound is chosen", async () => {
    const user = userEvent.setup();
    render(
      <FocusTimer
        {...base({
          settings: {
            timerStyle: null,
            minimalMode: false,
            keepAwake: false,
            alarmEnabled: false,
            sound: "lofi_calm",
          },
        })}
      />,
    );
    await start(user);
    expect(createLoopPlayer).toHaveBeenCalledWith("/audio/lofi-calm.mp3");
    expect(loop.play).toHaveBeenCalled();
  });
});

describe("FocusTimer — alarm + auto-expand at time's-up (fake timers)", () => {
  it("fires the alarm and auto-expands the tracker when the countdown hits zero", async () => {
    vi.useFakeTimers();
    try {
      render(<FocusTimer {...base()} />); // step estMinutes = 1 → 60s
      // Start via a native click wrapped in act, then flush the async beginFocus
      // + the "running" effect so the countdown interval is installed. (userEvent
      // is avoided here: it interacts awkwardly with fake timers for the async
      // Start server action.)
      await act(async () => {
        screen.getByRole("button", { name: /start focusing/i }).click();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(alarmPlay).toHaveBeenCalled();
      expect(screen.getByRole("button", { name: /steps/i })).toHaveAttribute(
        "aria-expanded",
        "true",
      );
      expect(screen.getByText(/time's up/i)).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("FocusTimer — complete", () => {
  it("Complete step calls completeFocus and stops the loop", async () => {
    const user = userEvent.setup();
    render(
      <FocusTimer
        {...base({
          settings: {
            timerStyle: null,
            minimalMode: false,
            keepAwake: false,
            alarmEnabled: false,
            sound: "lofi_calm",
          },
        })}
      />,
    );
    await start(user);
    await user.click(screen.getByRole("button", { name: /complete step/i }));
    expect(completeFocus).toHaveBeenCalled();
    expect(loop.stop).toHaveBeenCalled();
  });
});
