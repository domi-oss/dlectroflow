// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  act,
  waitFor,
  within,
} from "@testing-library/react";
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
  pauseFocus: vi.fn().mockResolvedValue({ ok: true }),
  resumeFocus: vi.fn().mockResolvedValue({
    ok: true,
    remainingSec: 300,
    totalSec: 600,
    plannedMin: 10,
  }),
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
const wakeRelease = vi.fn();
const createAlarm = vi.fn((..._args: unknown[]) => ({ play: alarmPlay }));
const acquireWakeLock = vi.fn((..._args: unknown[]) =>
  Promise.resolve({ release: wakeRelease }),
);
vi.mock("@/lib/focus-sounds", () => ({
  createAlarm: (...a: unknown[]) => createAlarm(...a),
  acquireWakeLock: (...a: unknown[]) => acquireWakeLock(...a),
}));

// #43 — the shared lo-fi player controls (useFocusSound) are mocked so we can
// assert the timer drives them (play on Start, stop on complete) without audio.
const soundControls = {
  track: {
    id: "lofi_calm",
    title: "Aurora on Mute",
    category: "ambient-lofi",
    categoryLabel: "Ambient lo-fi",
    src: "/audio/lofi/aurora-on-mute.mp3",
  },
  playing: false,
  volume: 0.5,
  hasTracks: true,
  play: vi.fn(),
  pause: vi.fn(),
  toggle: vi.fn(),
  next: vi.fn(),
  prev: vi.fn(),
  setVolume: vi.fn(),
  stop: vi.fn(),
};
vi.mock("@/lib/use-focus-sound", () => ({
  useFocusSound: () => soundControls,
  DEFAULT_FOCUS_VOLUME: 0.5,
}));
// The mini-player's own behaviour is covered in focus-sound-player.test.tsx;
// stub it here so its real play/pause labels don't collide with the timer's
// controls. The stub forwards controls.toggle via a uniquely-named button so we
// can assert the coupling is one-directional (mini-player → audio only).
vi.mock("@/components/focus/focus-sound-player", () => ({
  FocusSoundPlayer: ({ controls }: { controls: { toggle: () => void } }) => (
    <div data-testid="focus-sound-player">
      <button type="button" onClick={() => controls.toggle()}>
        mini sound toggle
      </button>
    </div>
  ),
}));

import {
  beginFocus,
  completeFocus,
  pauseFocus,
  resumeFocus,
} from "@/app/actions/focus";
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
    existingSession: null,
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
    await user.click(screen.getByRole("button", { name: /add 5 minutes/i }));
    // The signed net note is a <p>; scope the match to it (the add/subtract
    // buttons now carry aria-labels + icons, not a "+5m" accessible name).
    expect(screen.getByText(/\+5m/, { selector: "p" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /subtract 5 minutes/i }),
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
    // #27 — pausing now awaits the server (pauseFocus) before the phase
    // flips, so the aria-expanded update lands a tick after the click.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /steps/i })).toHaveAttribute(
        "aria-expanded",
        "true",
      ),
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
  it("primes alarm + acquires the wake lock on Start when enabled; no lofi when sound is off", async () => {
    const user = userEvent.setup();
    render(<FocusTimer {...base()} />);
    await start(user);
    expect(beginFocus).toHaveBeenCalledWith("s2", 1);
    expect(createAlarm).toHaveBeenCalled();
    expect(acquireWakeLock).toHaveBeenCalled();
    expect(soundControls.play).not.toHaveBeenCalled();
    // With sound off, the mini-player is not rendered.
    expect(screen.queryByTestId("focus-sound-player")).not.toBeInTheDocument();
  });

  it("does NOT prime alarm / wake lock / lofi when all are disabled", async () => {
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
    expect(soundControls.play).not.toHaveBeenCalled();
  });

  it("starts the lofi player + shows the mini-player when a sound is chosen", async () => {
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
    expect(soundControls.play).toHaveBeenCalled();
    expect(screen.getByTestId("focus-sound-player")).toBeInTheDocument();
  });

  it("pauses the lofi with the timer and resumes it on resume (moves together)", async () => {
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
    expect(soundControls.play).toHaveBeenCalled();
    // Pause the timer → audio pauses.
    await user.click(screen.getByRole("button", { name: /pause/i }));
    expect(soundControls.pause).toHaveBeenCalled();
    // Resume the timer → audio resumes.
    soundControls.play.mockClear();
    await user.click(screen.getByRole("button", { name: /resume/i }));
    expect(soundControls.play).toHaveBeenCalled();
  });

  it("toggling the mini-player does NOT change the timer phase (one-directional)", async () => {
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
    // Running → the timer shows Pause (not Resume).
    expect(screen.getByRole("button", { name: /pause/i })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /resume/i }),
    ).not.toBeInTheDocument();
    // Toggle the music from the mini-player.
    await user.click(
      screen.getByRole("button", { name: /mini sound toggle/i }),
    );
    expect(soundControls.toggle).toHaveBeenCalled();
    // The timer phase is unchanged — still running (Pause shown, no Resume).
    expect(screen.getByRole("button", { name: /pause/i })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /resume/i }),
    ).not.toBeInTheDocument();
  });

  it("hides the mini-player in minimal mode while running", async () => {
    const user = userEvent.setup();
    render(
      <FocusTimer
        {...base({
          settings: {
            timerStyle: null,
            minimalMode: true,
            keepAwake: false,
            alarmEnabled: false,
            sound: "lofi_calm",
          },
        })}
      />,
    );
    await start(user);
    // Sound still starts (ambient bed), but its chrome is hidden while running.
    expect(soundControls.play).toHaveBeenCalled();
    expect(screen.queryByTestId("focus-sound-player")).not.toBeInTheDocument();
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
  it("Complete step calls completeFocus and stops the lofi player", async () => {
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
    expect(soundControls.stop).toHaveBeenCalled();
  });
});

// #27 — the in-session Pause/Resume toggle now persists real server state
// instead of only flipping local phase.
describe("FocusTimer — true pause/resume persistence", () => {
  it("Pause calls pauseFocus with the session id + current totalSec", async () => {
    const user = userEvent.setup();
    render(<FocusTimer {...base()} />);
    await start(user);
    await user.click(screen.getByRole("button", { name: /pause/i }));
    expect(pauseFocus).toHaveBeenCalledWith("session-1", { totalSec: 60 }); // 1-minute step
  });

  it("Resume (in-session) calls resumeFocus and restores the returned remaining time", async () => {
    const user = userEvent.setup();
    render(<FocusTimer {...base()} />);
    await start(user);
    await user.click(screen.getByRole("button", { name: /pause/i }));
    await user.click(screen.getByRole("button", { name: /resume/i }));
    expect(resumeFocus).toHaveBeenCalledWith("session-1");
    // The mock resolves remainingSec: 300 → 5:00 on the readout.
    expect(screen.getByText("5:00")).toBeInTheDocument();
  });

  it("a failed resume falls back to running rather than stranding the user paused", async () => {
    (resumeFocus as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      remainingSec: 0,
      totalSec: 0,
      plannedMin: 0,
    });
    const user = userEvent.setup();
    render(<FocusTimer {...base()} />);
    await start(user);
    await user.click(screen.getByRole("button", { name: /pause/i }));
    await user.click(screen.getByRole("button", { name: /resume/i }));
    // Back to the running controls (Pause visible again), not stuck on Resume.
    expect(
      screen.getByRole("button", { name: /^pause$/i }),
    ).toBeInTheDocument();
  });

  // Duo review: pauseFocus's result wasn't checked — the UI showed "paused"
  // even when the server rejected it (e.g. another device/concurrent request
  // already closed the session). The server's answer must win.
  it("a failed pause stays on the running controls instead of showing a paused state the server doesn't have", async () => {
    (pauseFocus as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
    });
    const user = userEvent.setup();
    render(<FocusTimer {...base()} />);
    await start(user);
    await user.click(screen.getByRole("button", { name: /pause/i }));
    expect(pauseFocus).toHaveBeenCalledWith("session-1", { totalSec: 60 });
    // Still showing the running controls (Pause button), not Resume.
    expect(
      screen.getByRole("button", { name: /^pause$/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^resume$/i }),
    ).not.toBeInTheDocument();
  });
});

describe("FocusTimer — setup screen: existing paused session (#27)", () => {
  const paused = {
    id: "sess-paused",
    plannedMin: 10,
    totalSec: 600,
    remainingSec: 222, // → ceil(222/60) = 4m
  };

  it("offers BOTH Resume and Start fresh instead of a single Start CTA", () => {
    render(<FocusTimer {...base({ existingSession: paused })} />);
    expect(
      screen.getByRole("button", { name: /resume.*4m.*left/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /start fresh/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^start focusing$/i }),
    ).not.toBeInTheDocument();
  });

  it("Resume reuses the existing session (resumeFocus) — no new beginFocus call", async () => {
    const user = userEvent.setup();
    render(<FocusTimer {...base({ existingSession: paused })} />);
    await user.click(screen.getByRole("button", { name: /resume.*left/i }));
    expect(resumeFocus).toHaveBeenCalledWith("sess-paused");
    expect(beginFocus).not.toHaveBeenCalled();
  });

  it("Start fresh discloses the duration chips first, THEN begins on Start (server retires the stale session)", async () => {
    const user = userEvent.setup();
    render(<FocusTimer {...base({ existingSession: paused })} />);
    // #66 — "Start fresh" is a disclosure, not the launch: it swaps the Resume
    // choice for the duration chips + Start, so the length is chosen before any
    // session begins (and a mis-tap hasn't retired the paused row yet).
    await user.click(screen.getByRole("button", { name: /start fresh/i }));
    expect(beginFocus).not.toHaveBeenCalled();
    // The preselected chip is the SESSION's plannedMin (10) — the number the
    // ring is showing — not the step's stale estimate (1). See the !139 bugfix
    // block below.
    expect(screen.getByRole("button", { name: "10m" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await user.click(screen.getByRole("button", { name: /^start focusing$/i }));
    expect(beginFocus).toHaveBeenCalledWith("s2", 10);
    expect(resumeFocus).not.toHaveBeenCalled();
  });

  // Bug fix (owner-reported, !139): pauseFocus() bakes mid-session +time taps
  // into the SESSION's own plannedMin without ever touching Step.estMinutes —
  // so a 10m step that got +5m tapped twice then paused persists a session
  // with plannedMin=20/remaining~15m, while the ring/Duration used to seed
  // from the stale step.estMinutes (10). Result: ring said "of 10m" while the
  // Resume button (reading existingSession.remainingSec) said "~15m left" —
  // two different numbers for what's supposed to be the same session. !139
  // fixed the seeding; #66 closes the class of bug on the presentation side —
  // the setup ring is DERIVED from the one source per state, and the competing
  // figures (the "of Nm" total, the free-type Duration field) are gone, so
  // there is nothing left that can disagree with the CTA.
  describe("bugfix: the ring must agree with the Resume button's number", () => {
    // A 10m step (step.estMinutes), +5m tapped twice while running (session
    // totalSec grew to 20m), then paused with ~15m left of that 20m.
    const grown = {
      id: "sess-grown",
      plannedMin: 20,
      totalSec: 1200,
      remainingSec: 15 * 60,
    };

    it("multi-step: the ring reads the session's remaining time and nothing contradicts it", () => {
      render(
        <FocusTimer
          {...base({
            step: { ...base().step, estMinutes: 10 },
            existingSession: grown,
          })}
        />,
      );
      // The ring shows the session's remaining time, labelled for the step.
      expect(screen.getByText("15:00")).toBeInTheDocument();
      expect(screen.getByText("left on this step")).toBeInTheDocument();
      // No second figure: neither the "of Nm" total (10m or 20m)…
      expect(screen.queryByText(/of \d+m/)).not.toBeInTheDocument();
      // …nor a free-type Duration field.
      expect(screen.queryByRole("spinbutton")).not.toBeInTheDocument();
      // …and the CTA says exactly what the ring says — no more "ring says 10m,
      // button says ~15m left".
      expect(
        screen.getByRole("button", { name: /resume.*~15m.*left/i }),
      ).toBeInTheDocument();
    });

    it("single-task: same fix applies (FocusTimer is shared — existingSession/pauseFocus are step-generic)", () => {
      render(
        <FocusTimer
          {...base({
            isSingleTask: true,
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
            existingSession: grown,
          })}
        />,
      );
      expect(screen.getByText("15:00")).toBeInTheDocument();
      expect(
        screen.getByText("left — pick up where you paused"),
      ).toBeInTheDocument();
      expect(screen.queryByText(/of \d+m/)).not.toBeInTheDocument();
      expect(screen.queryByRole("spinbutton")).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: /resume.*~15m.*left/i }),
      ).toBeInTheDocument();
    });

    it("fresh start (no existing session) still seeds the chip + ring from step.estMinutes, unaffected", () => {
      render(
        <FocusTimer {...base({ step: { ...base().step, estMinutes: 10 } })} />,
      );
      expect(screen.getByRole("button", { name: "10m" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      expect(screen.getByText("10:00")).toBeInTheDocument();
      expect(screen.queryByText(/of \d+m/)).not.toBeInTheDocument();
    });
  });

  it("no existing session: the normal single Start CTA renders", () => {
    render(<FocusTimer {...base()} />);
    expect(
      screen.getByRole("button", { name: /start focusing/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /start fresh/i }),
    ).not.toBeInTheDocument();
  });
});

// #66 — the setup screen used to stack up to FOUR competing figures: the ring
// countdown, the step-context line ("Step 2 of 5 · ~38m left in task"), the
// Resume button's own "~Xm left", and a "Duration [n] min" number input (plus
// the ±Nm note). The rule these tests pin down: one number, one action on
// screen at a time — everything else revealed only when asked.
describe("FocusTimer — setup screen: one number, one action (#66)", () => {
  const singleTask = {
    isSingleTask: true,
    taskTitle: "Water the office plants",
    step: {
      id: "s1",
      text: "Water the office plants",
      estMinutes: 10,
      subtaskEmoji: null,
      order: 1,
      total: 1,
      done: false,
    },
    steps: [
      {
        id: "s1",
        text: "Water the office plants",
        done: false,
        estMinutes: 10,
        subtaskEmoji: null,
      },
    ],
    nextStep: null,
  } satisfies Partial<Parameters<typeof FocusTimer>[0]>;

  // ── State 1: single task, start fresh ────────────────────────────────────
  describe("state 1 — start fresh", () => {
    it("the ring shows the duration and only the duration (no 'of Nm' second figure)", () => {
      render(<FocusTimer {...base(singleTask)} />);
      expect(screen.getByText("10:00")).toBeInTheDocument();
      expect(screen.getByText("focus time")).toBeInTheDocument();
      expect(screen.queryByText(/of \d+m/)).not.toBeInTheDocument();
    });

    it("duration is a chip row preselected at the step's estimate — no free-type number field", () => {
      render(<FocusTimer {...base(singleTask)} />);
      expect(screen.queryByRole("spinbutton")).not.toBeInTheDocument();
      const group = screen.getByRole("group", { name: /focus for/i });
      expect(
        within(group)
          .getAllByRole("button")
          .map((b) => b.textContent),
      ).toEqual(["5m", "10m", "15m", "25m"]);
      expect(screen.getByRole("button", { name: "10m" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      expect(screen.getByRole("button", { name: "25m" })).toHaveAttribute(
        "aria-pressed",
        "false",
      );
    });

    it("tapping a chip moves the ring AND the minutes Start submits (one source of truth)", async () => {
      const user = userEvent.setup();
      render(<FocusTimer {...base(singleTask)} />);
      await user.click(screen.getByRole("button", { name: "25m" }));
      expect(screen.getByText("25:00")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "25m" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      expect(screen.getByRole("button", { name: "10m" })).toHaveAttribute(
        "aria-pressed",
        "false",
      );
      await user.click(
        screen.getByRole("button", { name: /^start focusing$/i }),
      );
      expect(beginFocus).toHaveBeenCalledWith("s1", 25);
    });

    it("an off-preset estimate gets its own chip, so the ring's number stays reachable", () => {
      render(
        <FocusTimer
          {...base({
            ...singleTask,
            step: { ...singleTask.step, estMinutes: 7 },
          })}
        />,
      );
      expect(screen.getByText("7:00")).toBeInTheDocument();
      const group = screen.getByRole("group", { name: /focus for/i });
      expect(
        within(group)
          .getAllByRole("button")
          .map((b) => b.textContent),
      ).toEqual(["5m", "7m", "10m", "15m", "25m"]);
      expect(screen.getByRole("button", { name: "7m" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    });

    it("a single task shows no subordinate task-total line (its total IS the step)", () => {
      render(<FocusTimer {...base(singleTask)} />);
      expect(
        screen.queryByText(/left on the whole task/),
      ).not.toBeInTheDocument();
    });
  });

  // ── State 2: single task, resume ──────────────────────────────────────────
  describe("state 2 — resume", () => {
    const paused = {
      id: "sess-paused",
      plannedMin: 10,
      totalSec: 600,
      remainingSec: 5 * 60,
    };

    it("the ring reads time left and agrees with the Resume CTA", () => {
      render(
        <FocusTimer {...base({ ...singleTask, existingSession: paused })} />,
      );
      expect(screen.getByText("5:00")).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: /resume.*~5m.*left/i }),
      ).toBeInTheDocument();
      expect(screen.queryByText(/of \d+m/)).not.toBeInTheDocument();
    });

    it("one quiet subordinate line repeats that same figure, rounded the same way", () => {
      render(
        <FocusTimer {...base({ ...singleTask, existingSession: paused })} />,
      );
      expect(screen.getByText("5 min left on this task")).toBeInTheDocument();
    });

    it("the duration chips stay hidden until 'Start fresh' asks for them", () => {
      render(
        <FocusTimer {...base({ ...singleTask, existingSession: paused })} />,
      );
      expect(
        screen.queryByRole("group", { name: /focus for/i }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "10m" }),
      ).not.toBeInTheDocument();
    });

    it("'Start fresh' reveals the chips and re-points the ring at the duration", async () => {
      const user = userEvent.setup();
      render(
        <FocusTimer {...base({ ...singleTask, existingSession: paused })} />,
      );
      await user.click(screen.getByRole("button", { name: /start fresh/i }));
      expect(
        screen.getByRole("group", { name: /focus for/i }),
      ).toBeInTheDocument();
      // The ring now shows the duration Start would use, not the paused
      // remainder — it always matches the action offered next to it.
      expect(screen.getByText("10:00")).toBeInTheDocument();
      expect(screen.getByText("focus time")).toBeInTheDocument();
      expect(screen.queryByText("5:00")).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: /resume/i }),
      ).not.toBeInTheDocument();
    });

    it("'Keep my paused session' undoes the disclosure — a mis-tap is not a dead end", async () => {
      const user = userEvent.setup();
      render(
        <FocusTimer {...base({ ...singleTask, existingSession: paused })} />,
      );
      await user.click(screen.getByRole("button", { name: /start fresh/i }));
      await user.click(
        screen.getByRole("button", { name: /keep my paused session/i }),
      );
      expect(
        screen.getByRole("button", { name: /resume.*~5m.*left/i }),
      ).toBeInTheDocument();
      expect(screen.getByText("5:00")).toBeInTheDocument();
      expect(
        screen.queryByRole("group", { name: /focus for/i }),
      ).not.toBeInTheDocument();
      // Nothing was committed either way.
      expect(beginFocus).not.toHaveBeenCalled();
      expect(resumeFocus).not.toHaveBeenCalled();
    });
  });

  // ── State 3: multi-step ───────────────────────────────────────────────────
  describe("state 3 — multi-step", () => {
    it("'Step N of M' is an eyebrow above the step title: progress is a count, not another minutes figure", () => {
      render(<FocusTimer {...base()} />);
      const eyebrow = screen.getByText("Step 2 of 3");
      expect(eyebrow.className).toMatch(/uppercase/);
      // The step title is still the hero heading…
      expect(
        screen.getByRole("heading", { name: /draft intro/i }).className,
      ).toMatch(/text-xl/);
      // …and the old welded-together context line is gone.
      expect(screen.queryByText(/left in task/)).not.toBeInTheDocument();
    });

    it("the task total is demoted to ONE quiet subordinate line", () => {
      render(<FocusTimer {...base()} />);
      // STEPS: s1 done (5m), s2 current (1m), s3 (10m) → 11m of work left, and
      // one step after this one.
      expect(
        screen.getByText("~11m left on the whole task · 1 step to go"),
      ).toBeInTheDocument();
    });

    it("pluralises the steps-to-go count", () => {
      render(<FocusTimer {...base({ step: { ...base().step, total: 5 } })} />);
      expect(screen.getByText(/· 3 steps to go$/)).toBeInTheDocument();
    });

    it("drops the steps-to-go clause on the last step", () => {
      render(
        <FocusTimer
          {...base({ step: { ...base().step, order: 3, total: 3 } })}
        />,
      );
      expect(
        screen.getByText("~11m left on the whole task"),
      ).toBeInTheDocument();
      expect(screen.queryByText(/steps? to go/)).not.toBeInTheDocument();
    });

    it("resuming a multi-step step: the ring is the STEP's time left, the task total stays quiet", () => {
      render(
        <FocusTimer
          {...base({
            existingSession: {
              id: "sess-multi",
              plannedMin: 20,
              totalSec: 1200,
              remainingSec: 12 * 60,
            },
          })}
        />,
      );
      expect(screen.getByText("12:00")).toBeInTheDocument();
      expect(screen.getByText("left on this step")).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: /resume.*~12m.*left/i }),
      ).toBeInTheDocument();
      expect(
        screen.getByText("~11m left on the whole task · 1 step to go"),
      ).toBeInTheDocument();
    });
  });

  // ── The collapsed numbers ─────────────────────────────────────────────────
  it("setup shows exactly ONE clock figure — no ±Nm note, no second total", () => {
    render(<FocusTimer {...base(singleTask)} />);
    expect(screen.getAllByText(/^\d+:\d\d$/)).toHaveLength(1);
    expect(screen.queryByText(/^[+−]\d+m$/)).not.toBeInTheDocument();
  });

  // ── a11y ──────────────────────────────────────────────────────────────────
  describe("a11y", () => {
    it("chips are aria-pressed toggles with ≥44px targets inside a named group", () => {
      render(<FocusTimer {...base(singleTask)} />);
      const chips = within(
        screen.getByRole("group", { name: /focus for/i }),
      ).getAllByRole("button");
      for (const chip of chips) {
        expect(chip.tagName).toBe("BUTTON");
        expect(chip).toHaveAttribute("aria-pressed");
        expect(chip.className).toMatch(/min-h-\[44px\]/);
        expect(chip.className).toMatch(/min-w-\[44px\]/);
      }
    });

    it("'Start fresh' / 'Keep my paused session' are real buttons with ≥44px targets", async () => {
      const user = userEvent.setup();
      render(
        <FocusTimer
          {...base({
            ...singleTask,
            existingSession: {
              id: "sess-paused",
              plannedMin: 10,
              totalSec: 600,
              remainingSec: 300,
            },
          })}
        />,
      );
      const fresh = screen.getByRole("button", { name: /start fresh/i });
      expect(fresh.tagName).toBe("BUTTON");
      expect(fresh.className).toMatch(/min-h-\[44px\]/);
      await user.click(fresh);
      const keep = screen.getByRole("button", {
        name: /keep my paused session/i,
      });
      expect(keep.tagName).toBe("BUTTON");
      expect(keep.className).toMatch(/min-h-\[44px\]/);
    });

    it("the disclosure moves focus to the newly-primary action instead of dropping it", async () => {
      const user = userEvent.setup();
      render(
        <FocusTimer
          {...base({
            ...singleTask,
            existingSession: {
              id: "sess-paused",
              plannedMin: 10,
              totalSec: 600,
              remainingSec: 300,
            },
          })}
        />,
      );
      // Both toggles unmount the button that was just clicked, so focus would
      // otherwise fall back to <body> mid-decision.
      await user.click(screen.getByRole("button", { name: /start fresh/i }));
      expect(
        screen.getByRole("button", { name: /^start focusing$/i }),
      ).toHaveFocus();
      await user.click(
        screen.getByRole("button", { name: /keep my paused session/i }),
      );
      expect(screen.getByRole("button", { name: /resume/i })).toHaveFocus();
    });

    it("the ring's live figure is exposed as text (the graphic itself is aria-hidden)", () => {
      const { container } = render(<FocusTimer {...base(singleTask)} />);
      expect(container.querySelector("svg")).toHaveAttribute(
        "aria-hidden",
        "true",
      );
      expect(screen.getByText("10:00")).toBeInTheDocument();
    });
  });
});
