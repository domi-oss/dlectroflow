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
import {
  FocusTimer,
  FOCUS_CATEGORY_SAVE_DEBOUNCE_MS,
  REESTIMATE_TIMEOUT_MS,
} from "@/components/focus/focus-timer";
import { AUTO_ADVANCE_SEC } from "@/components/focus/auto-advance";
import type { TrackerStep } from "@/components/focus/focus-step-tracker";
// `pickOne` reads the platform CSPRNG rather than `Math.random`, so the done
// message is only deterministic if that is what gets pinned. Shared helper
// (!275 review) — see src/lib/__tests__/mock-csprng.ts.
import { mockCsprngDraw } from "@/lib/__tests__/mock-csprng";

const refresh = vi.fn();
// #142 — `push` is module-level rather than created inside `useRouter()`: the
// auto-advance asserts on where it navigates, and a fresh spy per hook call
// records nothing the test can read.
const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh }),
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
  uncompleteStep: vi.fn().mockResolvedValue(undefined),
  proposeNewEstimate: vi.fn().mockResolvedValue(20),
  pauseFocus: vi.fn().mockResolvedValue({ ok: true }),
  resumeFocus: vi.fn().mockResolvedValue({
    ok: true,
    remainingSec: 300,
    totalSec: 600,
    plannedMin: 10,
  }),
}));
vi.mock("@/app/actions/braindump", () => ({
  ensureFocusStep: vi.fn().mockResolvedValue("new-step"),
}));
vi.mock("@/app/actions/settings", () => ({
  dismissFocusTimerTip: vi.fn().mockResolvedValue(undefined),
  updateFocusShuffle: vi.fn().mockResolvedValue(undefined),
  updateFocusSoundCategories: vi.fn().mockResolvedValue(undefined),
}));
// #89 — the paused ring's breathing pacer must be absent entirely under reduced
// motion, so this is per-test switchable (the mockVoice pattern below).
let mockReducedMotion = false;
vi.mock("@/lib/use-prefers-reduced-motion", () => ({
  usePrefersReducedMotion: () => mockReducedMotion,
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
  shuffle: false,
  toggleShuffle: vi.fn(),
};
// #68 — capture the hook's arguments so we can assert the timer seeds shuffle
// from Settings and writes a toggle back (the hook itself is covered in
// use-focus-sound.test.ts).
let soundHookArgs: unknown[] = [];
vi.mock("@/lib/use-focus-sound", () => ({
  useFocusSound: (...args: unknown[]) => {
    soundHookArgs = args;
    return soundControls;
  },
  DEFAULT_FOCUS_VOLUME: 0.5,
}));
// The mini-player's own behaviour is covered in focus-sound-player.test.tsx;
// stub it here so its real play/pause labels don't collide with the timer's
// controls. The stub resolves the transport press exactly as the real component
// does — the #65 session-coupled handler when the timer supplies one, otherwise
// controls.toggle — so these tests see which one the timer wired up. The volume
// button is here to prove what #65 deliberately does NOT couple.
vi.mock("@/components/focus/focus-sound-player", () => ({
  FocusSoundPlayer: ({
    controls,
    categories,
    onCategoriesChange,
    onPauseTogether,
    pauseTogetherPending,
  }: {
    controls: { toggle: () => void; setVolume: (v: number) => void };
    categories: readonly string[];
    onCategoriesChange: (next: string[]) => void;
    onPauseTogether?: () => void;
    pauseTogetherPending?: boolean;
  }) => (
    <div data-testid="focus-sound-player">
      <button
        type="button"
        disabled={pauseTogetherPending}
        onClick={() => (onPauseTogether ?? controls.toggle)()}
      >
        mini sound toggle
      </button>
      <button type="button" onClick={() => controls.setVolume(0)}>
        mini volume zero
      </button>
      {/* #181 — the panel's own behaviour is covered in
          focus-playlist-panel.test.tsx; this stub exposes the two props the
          TIMER owns, so these tests can see what it seeds and what it persists. */}
      <span data-testid="mini-categories">{categories.join(",")}</span>
      <button type="button" onClick={() => onCategoriesChange(["jazzhop"])}>
        mini tick jazzhop
      </button>
      <button type="button" onClick={() => onCategoriesChange(["late-night"])}>
        mini tick late-night
      </button>
    </div>
  ),
}));

import {
  beginFocus,
  completeFocus,
  pauseFocus,
  proposeNewEstimate,
  requeueFocus,
  resumeFocus,
  uncompleteStep,
} from "@/app/actions/focus";
import {
  dismissFocusTimerTip,
  updateFocusShuffle,
  updateFocusSoundCategories,
} from "@/app/actions/settings";
import { ensureFocusStep } from "@/app/actions/braindump";

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
  mockReducedMotion = false;
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

  // #151 — the guard that makes the sub-floor case unreachable from the UI.
  // `applyTimeDelta` no longer grows the clock without it, but it is still the
  // thing that stops the button being tappable when it would do nothing, so it
  // gets a test of its own: deleting `disabled={atFloor}` failed nothing here
  // before, which is how the floor came to be enforced in exactly one place.
  // `base()` estimates the step at 1m, so the session opens sitting ON the
  // floor (remaining 60s) with no ticking needed.
  it("disables −5m at the 60s floor, and re-enables it once there is room", async () => {
    const user = userEvent.setup();
    render(<FocusTimer {...base()} />);
    await start(user);
    const minus = screen.getByRole("button", { name: /subtract 5 minutes/i });
    expect(minus).toBeDisabled();
    await user.click(screen.getByRole("button", { name: /add 5 minutes/i }));
    expect(minus).toBeEnabled();
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
    // The timer phase is unchanged — still running (Pause shown, no Resume) —
    // and nothing was persisted: #65 must stay invisible until opted into.
    expect(screen.getByRole("button", { name: /pause/i })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /resume/i }),
    ).not.toBeInTheDocument();
    expect(pauseFocus).not.toHaveBeenCalled();
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

  // #68 — shuffle is a taste setting, so the timer seeds the playlist from
  // Settings and writes a toggle straight back (fire-and-forget, like the tip
  // dismissal). The ordering logic itself lives in the hook.
  it("seeds the playlist's shuffle from Settings and persists a toggle", () => {
    render(
      <FocusTimer
        {...base({
          settings: {
            timerStyle: null,
            minimalMode: false,
            keepAwake: false,
            alarmEnabled: false,
            sound: "on",
            categories: ["chillhop"],
            shuffle: true,
          },
        })}
      />,
    );
    // #180 — the hook takes one options object and no opening track: focusSound
    // is a switch, so there is no stored track to seed a session from.
    const opts = soundHookArgs[0] as {
      categories?: readonly string[];
      shuffle?: boolean;
      onShuffleChange?: (v: boolean) => void;
    };
    expect(soundHookArgs).toHaveLength(1);
    expect(opts.categories).toEqual(["chillhop"]);
    expect(opts.shuffle).toBe(true);
    act(() => opts.onShuffleChange?.(false));
    expect(updateFocusShuffle).toHaveBeenCalledWith(false);
  });

  // #181 — the tick-list lives in the player, so the SELECTION is timer state
  // now rather than a read-only prop: one value drives the pool the hook
  // resolves and the ticks the panel draws, and it is persisted on a debounce
  // because a tick is a click, not a form submit.
  describe("the playlist selection (#181)", () => {
    const withSound = (categories: string[]) =>
      base({
        settings: {
          timerStyle: null,
          minimalMode: false,
          keepAwake: false,
          alarmEnabled: false,
          sound: "on",
          categories,
        },
      });

    it("hands the same live selection to the hook and to the player", async () => {
      const user = userEvent.setup();
      render(<FocusTimer {...withSound(["chillhop"])} />);
      await start(user);
      expect(
        (soundHookArgs[0] as { categories?: readonly string[] }).categories,
      ).toEqual(["chillhop"]);
      expect(screen.getByTestId("mini-categories")).toHaveTextContent(
        "chillhop",
      );
    });

    it("a tick takes effect immediately, before anything is persisted", async () => {
      const user = userEvent.setup();
      render(<FocusTimer {...withSound(["chillhop"])} />);
      await start(user);
      await user.click(
        screen.getByRole("button", { name: /mini tick jazzhop/i }),
      );
      // The pool must follow the tick straight away — waiting on a debounced
      // round-trip to change what is playing would make the control feel broken.
      expect(
        (soundHookArgs[0] as { categories?: readonly string[] }).categories,
      ).toEqual(["jazzhop"]);
      expect(updateFocusSoundCategories).not.toHaveBeenCalled();
    });

    // The two below drive the DOM with act(...click()) rather than userEvent,
    // matching the other fake-timer tests in this file: the timer runs a 1s
    // countdown interval of its own, and userEvent's internal delay under fake
    // timers deadlocks against it.
    const press = async (name: RegExp) => {
      await act(async () => {
        screen.getByRole("button", { name }).click();
      });
    };

    it("collapses a burst of ticks into ONE write, of the last value", async () => {
      vi.useFakeTimers();
      try {
        render(<FocusTimer {...withSound([])} />);
        await press(/start focusing/i);
        await press(/mini tick jazzhop/i);
        await press(/mini tick late-night/i);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(FOCUS_CATEGORY_SAVE_DEBOUNCE_MS);
        });
        expect(updateFocusSoundCategories).toHaveBeenCalledTimes(1);
        expect(updateFocusSoundCategories).toHaveBeenCalledWith(["late-night"]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("flushes a pending write when the timer unmounts", async () => {
      // Ticking a playlist and then pressing Complete (or ← Back) inside the
      // debounce window must not silently lose the tick. Unlike the settings
      // page, this surface is one people leave abruptly and it has no save
      // indicator that could tell them the write never happened.
      vi.useFakeTimers();
      try {
        const { unmount } = render(<FocusTimer {...withSound([])} />);
        await press(/start focusing/i);
        await press(/mini tick jazzhop/i);
        expect(updateFocusSoundCategories).not.toHaveBeenCalled();
        act(() => unmount());
        expect(updateFocusSoundCategories).toHaveBeenCalledWith(["jazzhop"]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("writes nothing on unmount when nothing was ticked", async () => {
      const user = userEvent.setup();
      const { unmount } = render(<FocusTimer {...withSound(["chillhop"])} />);
      await start(user);
      unmount();
      expect(updateFocusSoundCategories).not.toHaveBeenCalled();
    });
  });

  it("defaults shuffle to off when Settings has never stored it", () => {
    // The prop, not the column: Settings.focusShuffle defaults TRUE for new
    // accounts since #180, but a caller that omits it still gets in-order
    // playback rather than a silently different default on the way down.
    render(<FocusTimer {...base()} />);
    expect((soundHookArgs[0] as { shuffle?: boolean }).shuffle).toBe(false);
  });
});

// #65 — the OPT-IN second direction of the #43 coupling. Off, the timer drives
// the music and nothing else (covered above). On, an explicit press of the
// mini-player's transport pauses/resumes the whole session — and nothing else
// does: the coupling is wired to that button, never to the audio element's
// state, so a finished track, a blocked autoplay or a volume change can't stop
// a focus session the user never asked to stop.
describe("FocusTimer — music↔timer pause coupling (#65)", () => {
  const lofi = (extra: Record<string, unknown> = {}) => ({
    timerStyle: null,
    minimalMode: false,
    keepAwake: false,
    alarmEnabled: false,
    sound: "lofi_calm",
    ...extra,
  });
  const miniToggle = () =>
    screen.getByRole("button", { name: /mini sound toggle/i });

  it("ON: pausing from the mini-player pauses the timer (and still the music)", async () => {
    const user = userEvent.setup();
    render(
      <FocusTimer {...base({ settings: lofi({ pauseTogether: true }) })} />,
    );
    await start(user);
    expect(screen.getByRole("button", { name: /pause/i })).toBeInTheDocument();

    await user.click(miniToggle());

    // The session is genuinely paused server-side, not just visually.
    expect(pauseFocus).toHaveBeenCalledWith("session-1", { totalSec: 60 });
    expect(
      await screen.findByRole("button", { name: /resume/i }),
    ).toBeInTheDocument();
    // The music stops too — that was the user's actual intent.
    expect(soundControls.pause).toHaveBeenCalled();
    // The audio-only path is bypassed: the session drives the audio via phase.
    expect(soundControls.toggle).not.toHaveBeenCalled();
  });

  it("ON: playing from the mini-player resumes the timer", async () => {
    const user = userEvent.setup();
    render(
      <FocusTimer {...base({ settings: lofi({ pauseTogether: true }) })} />,
    );
    await start(user);
    await user.click(miniToggle()); // → paused
    await screen.findByRole("button", { name: /resume/i });
    soundControls.play.mockClear();

    await user.click(miniToggle()); // → resume both

    expect(resumeFocus).toHaveBeenCalledWith("session-1");
    expect(
      await screen.findByRole("button", { name: /pause/i }),
    ).toBeInTheDocument();
    expect(soundControls.play).toHaveBeenCalled();
  });

  it("ON: the timer's own Pause/Resume still works (the other direction is unchanged)", async () => {
    const user = userEvent.setup();
    render(
      <FocusTimer {...base({ settings: lofi({ pauseTogether: true }) })} />,
    );
    await start(user);
    await user.click(screen.getByRole("button", { name: /pause/i }));
    expect(soundControls.pause).toHaveBeenCalled();
    expect(
      await screen.findByRole("button", { name: /resume/i }),
    ).toBeInTheDocument();
  });

  // The excluded cases. The timer never reads the hook's `playing` flag, so a
  // track ending (the playlist auto-advances), a browser autoplay block (play()
  // rejects and is swallowed) or the OS pausing the element cannot pause the
  // countdown. Only the button does.
  it("ON: a track ending / blocked autoplay does NOT pause the timer", async () => {
    const user = userEvent.setup();
    const props = base({ settings: lofi({ pauseTogether: true }) });
    const { rerender } = render(<FocusTimer {...props} />);
    await start(user);
    try {
      soundControls.playing = true;
      rerender(<FocusTimer {...props} />);
      expect(
        screen.getByRole("button", { name: /pause/i }),
      ).toBeInTheDocument();
      // Audio stopped by itself (ended / blocked / interrupted) — the session
      // must ride straight through it.
      soundControls.playing = false;
      rerender(<FocusTimer {...props} />);
      expect(
        screen.getByRole("button", { name: /pause/i }),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: /resume/i }),
      ).not.toBeInTheDocument();
      expect(pauseFocus).not.toHaveBeenCalled();
    } finally {
      soundControls.playing = false; // shared mock — leave it as found
    }
  });

  it("ON: silencing the music with the volume slider is not a pause", async () => {
    const user = userEvent.setup();
    render(
      <FocusTimer {...base({ settings: lofi({ pauseTogether: true }) })} />,
    );
    await start(user);
    await user.click(screen.getByRole("button", { name: /mini volume zero/i }));
    expect(soundControls.setVolume).toHaveBeenCalledWith(0);
    expect(screen.getByRole("button", { name: /pause/i })).toBeInTheDocument();
    expect(pauseFocus).not.toHaveBeenCalled();
  });

  // Minimal mode hides the mini-player while running, so a coupled resume
  // unmounts the very button that was just pressed. Focus must land on the
  // timer's own control, not on <body> (the #66 disclosure precedent).
  it("ON + minimal mode: a coupled resume hands focus to the timer's own control", async () => {
    const user = userEvent.setup();
    render(
      <FocusTimer
        {...base({
          settings: lofi({ pauseTogether: true, minimalMode: true }),
        })}
      />,
    );
    await start(user);
    // Player is hidden while running; pause the timer to reveal it.
    expect(screen.queryByTestId("focus-sound-player")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /pause/i }));
    const mini = await screen.findByRole("button", {
      name: /mini sound toggle/i,
    });

    await user.click(mini);

    await waitFor(() =>
      expect(
        screen.queryByTestId("focus-sound-player"),
      ).not.toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /pause/i })).toHaveFocus(),
    );
  });

  // The failure path has to hand focus over too, and consume the flag doing it.
  // A rejected resume falls back to "running" (#27), which IS a phase change, so
  // the effect fires, focus lands somewhere real, and nothing is left armed for
  // a later transition to spend as a focus jump (Duo review). The one route that
  // would leave it armed — a paused session with no session id — is unreachable
  // from the UI, which is why `togglePauseFromPlayer` guards on `sessionId`
  // rather than this being testable here.
  it("ON + minimal mode: a REJECTED coupled resume still hands focus over, not to <body>", async () => {
    const user = userEvent.setup();
    vi.mocked(resumeFocus).mockResolvedValueOnce({
      ok: false,
    } as unknown as Awaited<ReturnType<typeof resumeFocus>>);
    render(
      <FocusTimer
        {...base({
          settings: lofi({ pauseTogether: true, minimalMode: true }),
        })}
      />,
    );
    await start(user);
    await user.click(screen.getByRole("button", { name: /pause/i }));
    await user.click(
      await screen.findByRole("button", { name: /mini sound toggle/i }),
    );

    // Server said no → back to running (the #27 fail-safe), player unmounted,
    // focus handed over rather than dropped.
    await waitFor(() =>
      expect(
        screen.queryByTestId("focus-sound-player"),
      ).not.toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /pause/i })).toHaveFocus(),
    );
    // The session really did fall back to running, so this is the fail-safe
    // path and not a successful resume in disguise.
    expect(resumeFocus).toHaveBeenCalledWith("session-1");
  });
});

// #89 — the ring is a paced breathing guide for the whole live session: it
// starts with the session, runs through any pause, and stops when the clock
// does. (Built pause-only first; the owner widened the scope after seeing it
// working, and named reduced motion as the one off switch.) The pacer keys off
// the timer PHASE, never off which control was pressed, so #65's coupled player
// transport can neither start nor stop it out of step with the session.
// (The cadence itself is CSS — see globals.breathe.test.ts.)
describe("FocusTimer — breathing pacer through the live session (#89)", () => {
  const ringSvg = () =>
    screen.getByTestId("timer-visual-ring").querySelector("svg");
  const lofiCoupled = {
    timerStyle: null,
    minimalMode: false,
    keepAwake: false,
    alarmEnabled: false,
    sound: "lofi_calm",
    pauseTogether: true,
  };

  it("setup is still; Start begins the pacer; it carries on through a pause and a resume", async () => {
    const user = userEvent.setup();
    render(<FocusTimer {...base()} />);
    // The setup screen is a decision, not a session.
    expect(ringSvg()).not.toHaveAttribute("data-breathing");

    await start(user);
    expect(ringSvg()).toHaveAttribute("data-breathing");

    await user.click(screen.getByRole("button", { name: /pause/i }));
    const resume = await screen.findByRole("button", { name: /resume/i });
    expect(ringSvg()).toHaveAttribute("data-breathing");
    // The breath must never be in the way of getting back to work.
    expect(resume).toBeVisible();
    expect(resume).toBeEnabled();

    await user.click(resume);
    expect(
      await screen.findByRole("button", { name: /pause/i }),
    ).toBeInTheDocument();
    expect(ringSvg()).toHaveAttribute("data-breathing");
  });

  // "Keep going until the timer is up" (owner) — so time's-up is where it stops.
  // That screen asks a question and turns the ring amber to ask it.
  it("stops when the clock runs out", async () => {
    vi.useFakeTimers();
    try {
      render(<FocusTimer {...base()} />); // step estMinutes = 1 → 60s
      await act(async () => {
        screen.getByRole("button", { name: /start focusing/i }).click();
      });
      expect(ringSvg()).toHaveAttribute("data-breathing");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(screen.getByText("How did that go?")).toBeInTheDocument();
      expect(ringSvg()).not.toHaveAttribute("data-breathing");
    } finally {
      vi.useRealTimers();
    }
  });

  // Minimal mode strips the screen back to the countdown and its controls; it is
  // not a motion preference, and the owner's instruction carries no exception for
  // it (flagged on !177 so it can be overridden). Reduced motion is the off
  // switch, and it works in minimal mode like anywhere else.
  it("keeps running in focusMinimalMode (which strips controls, not motion)", async () => {
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
    expect(screen.queryByRole("button", { name: /steps/i })).toBeNull();
    expect(ringSvg()).toHaveAttribute("data-breathing");
  });

  // #65 gave the pause path a second entrance. The pacer reads the phase, and
  // the phase is all a coupled press changes — so the breath is untouched by
  // either entrance, exactly as it is untouched by the timer's own button.
  it("#65 ON: a coupled pause and resume leave the pacer running", async () => {
    const user = userEvent.setup();
    render(<FocusTimer {...base({ settings: lofiCoupled })} />);
    await start(user);
    expect(ringSvg()).toHaveAttribute("data-breathing");

    await user.click(
      screen.getByRole("button", { name: /mini sound toggle/i }),
    );
    expect(
      await screen.findByRole("button", { name: /resume/i }),
    ).toBeInTheDocument();
    expect(ringSvg()).toHaveAttribute("data-breathing");

    await user.click(
      screen.getByRole("button", { name: /mini sound toggle/i }),
    );
    expect(
      await screen.findByRole("button", { name: /pause/i }),
    ).toBeInTheDocument();
    expect(ringSvg()).toHaveAttribute("data-breathing");
  });

  // Reduced motion is the ONLY off switch — there is no in-app setting (owner).
  it("reduced motion: no pacer at any point in the session", async () => {
    mockReducedMotion = true;
    const user = userEvent.setup();
    render(<FocusTimer {...base()} />);
    await start(user);
    expect(ringSvg()).not.toHaveAttribute("data-breathing");
    await user.click(screen.getByRole("button", { name: /pause/i }));
    await screen.findByRole("button", { name: /resume/i });
    expect(ringSvg()).not.toHaveAttribute("data-breathing");
  });

  // A session has to be STARTED. The setup screen's resumable-session offer
  // (#27/#66) is a decision screen — the session behind it is not live yet.
  it("the setup screen's resumable session does not breathe", () => {
    render(
      <FocusTimer
        {...base({
          existingSession: {
            id: "sess-1",
            plannedMin: 10,
            totalSec: 600,
            remainingSec: 300,
          },
        })}
      />,
    );
    expect(screen.getByRole("button", { name: /resume/i })).toBeInTheDocument();
    expect(ringSvg()).not.toHaveAttribute("data-breathing");
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
      expect(screen.getByText("How did that go?")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});

// #99 — the live session's two primary confirm CTAs. Solid `bg-green-600`
// (#00a63e) with `text-white` is 3.21:1 as axe measures it in the running app
// (the issue's 3.27 was derived from the reported lab() value; the real ratio is
// slightly worse, not better), and AA-normal needs 4.5:1 — 16px at
// weight 500 is not "large text" (that needs 18.66px bold / 24px), so the 3:1
// allowance does not apply. It failed in BOTH themes: the class is a fixed
// Tailwind colour with no dark variant and `text-white` never changes.
//
// green-700 (#008236) is the weight that fixes it without trading one failure
// for another: white on it is 4.95:1 (AA-normal, clear of the floor), while the
// button — a solid fill with no border, so the fill IS its visual boundary —
// keeps 4.65:1 against the light page background and 3.97:1 against the dark
// one, both over the 3:1 WCAG 1.4.11 non-text floor. green-800 would read
// better on paper for the label (7.13:1) but drops that boundary to 2.75:1 on
// the dark background, i.e. an AA failure of a different clause.
//
// Asserted here as well as in e2e (which removes both `bg-green-600` entries
// from e2e/a11y/axe-baseline.json and adds the running session to the
// zero-tolerance contrast gate in both themes): this is the cheap check that
// says which weight, in a file a palette edit is likely to touch.
describe("FocusTimer — green CTA contrast (#99 a11y)", () => {
  it("the running session's 'Complete step' CTA uses AA green-700, not sub-AA green-600", async () => {
    const user = userEvent.setup();
    render(<FocusTimer {...base()} />);
    await start(user);
    const complete = screen.getByRole("button", { name: /complete step/i });
    expect(complete.className).toContain("bg-green-700");
    expect(complete.className).not.toContain("bg-green-600");
    // The white label is the other half of the pair — it must stay white, or
    // the measured 4.95:1 is not what ships.
    expect(complete.className).toContain("text-white");
  });

  it("the time's-up 'All done' CTA uses the same AA green-700", async () => {
    vi.useFakeTimers();
    try {
      render(<FocusTimer {...base()} />); // step estMinutes = 1 → 60s
      await act(async () => {
        screen.getByRole("button", { name: /start focusing/i }).click();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      const yesDone = screen.getByRole("button", { name: /^all done$/i });
      expect(yesDone.className).toContain("bg-green-700");
      expect(yesDone.className).not.toContain("bg-green-600");
      expect(yesDone.className).toContain("text-white");
    } finally {
      vi.useRealTimers();
    }
  });
});

// #138 — the time-up screen used to offer two answers, done or re-estimate. In
// real use the commonest answer is a third one: "no, and I already know roughly
// how much longer I need" — which the old screen forced through an AI round-trip
// for a decision the user had already made.
//
// The heading is now a question the three options each COMPLETE, so they read as
// parallel answers rather than a verdict plus a menu. Re-estimation is reframed
// as "not sure" rather than "no", because once the keep-going row exists, "no"
// is answered by tapping a number.
describe("FocusTimer — time-up: keep going for N more minutes (#138)", () => {
  /** Start the 1-minute step and let the clock run out. Fake timers only. */
  async function runToTimeUp() {
    render(<FocusTimer {...base()} />); // step estMinutes = 1 → 60s
    await act(async () => {
      screen.getByRole("button", { name: /start focusing/i }).click();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("asks the question the three options answer", async () => {
    await runToTimeUp();
    expect(screen.getByText("How did that go?")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^all done$/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: /not sure how much longer — ask claude/i,
      }),
    ).toBeInTheDocument();
  });

  // The row is one sentence: bare numbers in the buttons, the unit said once at
  // the end. Unlike the setup chips, which each carry their own "10m" because
  // there a chip is a standalone value rather than part of a phrase.
  it("offers 15/30/45/60 as a labelled group, not four bare numbers", async () => {
    await runToTimeUp();
    const group = screen.getByRole("group", { name: /keep going for/i });
    expect(
      within(group)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["15", "30", "45", "60"]);
    // The label and unit are OUTSIDE the group (Duo review): inside, the label
    // is both the accessible name and traversal content, which some screen
    // readers announce twice. So the group holds only the buttons…
    expect(group).toHaveTextContent(/^15304560$/);
    expect(within(group).queryByText(/keep going for/i)).toBeNull();
    expect(within(group).queryByText(/^min$/)).toBeNull();
    // …while the row as a whole still reads as one sentence, unit said once.
    const row = group.parentElement as HTMLElement;
    expect(row).toHaveTextContent(/Keep going for\s*15\s*30\s*45\s*60\s*min/);
  });

  it("tapping one adds that time and returns to a running countdown", async () => {
    await runToTimeUp();
    const group = screen.getByRole("group", { name: /keep going for/i });
    await act(async () => {
      within(group)
        .getByRole("button", { name: /^add 30 minutes$/i })
        .click();
    });
    // Back to running: the pause control is the running screen's, and the
    // question is gone. 30:00 exactly, because the countdown was at 0:00.
    expect(screen.queryByText("How did that go?")).not.toBeInTheDocument();
    expect(screen.getByText("30:00")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /pause/i })).toBeInTheDocument();
  });

  // Duo review: the time-up block stays mounted while a completeFocus is in
  // flight, because the phase only moves once the server answers. Without a
  // `pending` guard a tap here sets the phase to `running` and then
  // finishComplete resolves and overrides it with `done` — the keep-going choice
  // silently discarded, and the user sent to the celebration screen they had
  // just declined. Same family as #137/#139: a server action's outcome racing a
  // local phase change.
  it("cannot be tapped while a completeFocus is still in flight", async () => {
    type CompleteReturn = Awaited<ReturnType<typeof completeFocus>>;
    let settle: (v: CompleteReturn) => void = () => {};
    vi.mocked(completeFocus).mockReturnValueOnce(
      new Promise<CompleteReturn>((resolve) => {
        settle = resolve;
      }),
    );
    await runToTimeUp();
    // Start the completion but do not let it resolve.
    await act(async () => {
      screen.getByRole("button", { name: /^all done$/i }).click();
    });

    const group = screen.getByRole("group", { name: /keep going for/i });
    for (const b of within(group).getAllByRole("button")) {
      expect(b).toBeDisabled();
    }
    // "ask Claude" too (Duo review): it carries the same `disabled={pending}` and
    // the same race — startReestimate would move the phase to `reestimate` only
    // for the resolving completeFocus to overwrite it with `done`. Asserting only
    // the keep-going row would let a refactor drop this one and stay green.
    expect(screen.getByRole("button", { name: /ask claude/i })).toBeDisabled();
    // Still on the question, so the window Duo described is genuinely open.
    expect(screen.getByText("How did that go?")).toBeInTheDocument();

    // Settled inside act with a microtask flush (Duo review): resolving
    // completeFocus triggers goToPhase("done"), stopSound() and
    // router.refresh(), and letting those land outside React's batching leaves
    // the component mid-update and emits "not wrapped in act(...)".
    await act(async () => {
      settle({ ok: true } as CompleteReturn);
      await Promise.resolve();
    });
  });

  it("drops the old bare +5m button — the row supersedes it", async () => {
    await runToTimeUp();
    expect(
      screen.queryByRole("button", { name: /^add 5 minutes$/i }),
    ).not.toBeInTheDocument();
  });

  it("each keep-going button is a ≥44px target with a spoken label", async () => {
    await runToTimeUp();
    const group = screen.getByRole("group", { name: /keep going for/i });
    for (const b of within(group).getAllByRole("button")) {
      expect(b.tagName).toBe("BUTTON");
      expect(b).toHaveAccessibleName(/^Add \d+ minutes$/);
      expect(b.className).toMatch(/min-h-\[44px\]/);
      expect(b.className).toMatch(/min-w-\[44px\]/);
    }
  });

  // The alarm firing is not a user action, so time-up must NOT grab focus —
  // that would be WCAG 3.2.1, and it would yank a screen reader mid-sentence.
  it("does not steal focus when the alarm fires", async () => {
    await runToTimeUp();
    expect(
      screen.getByRole("button", { name: /^all done$/i }),
    ).not.toHaveFocus();
  });

  // …but a keep-going TAP is a user action, and it unmounts the button that was
  // pressed. WCAG 2.4.3: hand focus to the running screen's primary control
  // rather than dropping it to <body>. Same hand-off the #65 coupled transport
  // uses, deliberately reused rather than reimplemented.
  it("hands focus to the running control instead of dropping it to body", async () => {
    await runToTimeUp();
    const group = screen.getByRole("group", { name: /keep going for/i });
    await act(async () => {
      within(group)
        .getByRole("button", { name: /^add 45 minutes$/i })
        .click();
    });
    expect(screen.getByRole("button", { name: /pause/i })).toHaveFocus();
    expect(document.body).not.toHaveFocus();
  });

  // Duo review round 2, and a sharp catch. The #65 hand-off effect stands down
  // when `showSoundPlayer` is true, because in the coupled-transport case the
  // button the user pressed is still on screen and moving focus would be rude.
  // The keep-going case is the opposite — the pressed button lived in the
  // `timeup` block, which has just unmounted. And `showSoundPlayer` is *false*
  // during `timeup` (`sessionActive` is false there) and flips to *true* on the
  // way to `running`, so with sound enabled the hand-off was skipped exactly
  // when it was most needed and focus fell to <body>. WCAG 2.4.3.
  //
  // Every other test here uses base()'s `sound: "off"`, which keeps
  // `showSoundPlayer` false throughout and structurally cannot see this.
  it("hands focus off even with the sound player on screen after the transition", async () => {
    render(
      <FocusTimer
        {...base({
          settings: {
            timerStyle: null,
            minimalMode: false,
            keepAwake: true,
            alarmEnabled: true,
            sound: "lofi_calm",
          },
        })}
      />,
    );
    await act(async () => {
      screen.getByRole("button", { name: /start focusing/i }).click();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    const group = screen.getByRole("group", { name: /keep going for/i });
    await act(async () => {
      within(group)
        .getByRole("button", { name: /^add 15 minutes$/i })
        .click();
    });
    expect(screen.getByRole("button", { name: /^pause$/i })).toHaveFocus();
    expect(document.body).not.toHaveFocus();
  });

  // Duo review round 2: the comment claimed "done → keep going → not sure", but
  // "ask Claude" sat in the same flex row as "All done", so the DOM (and so tab
  // and screen-reader) order announced the AI round-trip BEFORE the four
  // immediate choices — the opposite of the stated rationale.
  it("orders the answers done → keep going → not sure in the DOM", async () => {
    await runToTimeUp();
    const labels = screen
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label") ?? b.textContent ?? "")
      .filter((t) => /all done|add \d+ minutes|ask claude/i.test(t));
    expect(labels).toEqual([
      "All done",
      "Add 15 minutes",
      "Add 30 minutes",
      "Add 45 minutes",
      "Add 60 minutes",
      "Not sure how much longer — ask Claude",
    ]);
  });

  it("playful voice keeps the food register the app already ships", async () => {
    mockVoice = "playful";
    await runToTimeUp();
    expect(screen.getByText("Plate cleared?")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^devoured it$/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("group", { name: /back for seconds/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^no idea — ask claude$/i }),
    ).toBeInTheDocument();
  });
});

describe("FocusTimer — the accidental-completion guard (#197)", () => {
  // Reported as FIVE separate accidental completions by one user: `Complete step`
  // held the leading slot of the running-session control row, which is where
  // every media and timer convention puts Pause. The irreversible action was
  // sitting in the muscle-memory position of the reversible one, wearing the only
  // filled colour in the row — and until #198 there was no way back at all for a
  // step whose task still had other open steps.
  //
  // The decision on #197 was reorder + undo and explicitly NOT a confirm dialog,
  // so these two assertions are the entire mechanical guard. That is why they
  // assert order rather than looks alone: a future style pass may re-colour the
  // row, and the ordering must survive it.
  //
  // DOM order is the right axis to pin. The row is `flex-wrap` with no `order-*`
  // utilities, so source order IS visual order, and it is also the sequence a
  // keyboard or switch user tabs through — one assertion covering both.
  async function running(user: ReturnType<typeof userEvent.setup>) {
    render(<FocusTimer {...base()} />);
    await start(user);
    return {
      complete: screen.getByRole("button", { name: /complete step/i }),
      pause: screen.getByRole("button", { name: /pause/i }),
    };
  }

  it("puts Pause BEFORE Complete step, in DOM and therefore tab order", async () => {
    const user = userEvent.setup();
    const { complete, pause } = await running(user);
    // compareDocumentPosition rather than an index into `children`: it still
    // holds if the two ever stop being siblings, which a later layout change
    // could easily do without meaning to reopen this bug.
    expect(
      pause.compareDocumentPosition(complete) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("gives Pause the filled treatment, so Complete is no longer the only filled button", async () => {
    const user = userEvent.setup();
    const { complete, pause } = await running(user);
    // `bg-primary`/`text-primary-foreground` and not a new colour pair: globals.css
    // documents the light token at 5.42:1 and ships a dark variant, so this
    // re-weighting cannot introduce the state-dependent contrast failure #109 and
    // #99 were both about.
    expect(pause.className).toContain("bg-primary");
    expect(pause.className).toContain("text-primary-foreground");
    // Complete keeps #99's measured AA green. This issue re-weights the row; it
    // does not reopen the contrast question.
    expect(complete.className).toContain("bg-green-700");
    expect(complete.className).toContain("text-white");
  });
});

describe("FocusTimer — putting a step back after an accident (#198)", () => {
  // The recovery half of #197. It is on the DONE screen because that is where an
  // accidental completion is discovered — the tick has landed and the countdown
  // to the next step has already started. Before this the only un-complete route
  // was `reopenItem` from the inbox Done view, which a step inside a
  // still-unfinished task never reaches.
  async function completeAStep(user: ReturnType<typeof userEvent.setup>) {
    render(<FocusTimer {...base()} />);
    await start(user);
    await user.click(screen.getByRole("button", { name: /complete step/i }));
  }

  it("offers the undo on the done screen and calls uncompleteStep for THIS step", async () => {
    const user = userEvent.setup();
    await completeAStep(user);
    await user.click(
      screen.getByRole("button", { name: /actually, i hadn't finished/i }),
    );
    expect(uncompleteStep).toHaveBeenCalledWith("s2");
  });

  it("leaves the celebration and confirms out loud that the step is open again", async () => {
    const user = userEvent.setup();
    await completeAStep(user);
    await user.click(
      screen.getByRole("button", { name: /actually, i hadn't finished/i }),
    );
    // Back on the step's own setup screen, so it can simply be started again.
    expect(
      await screen.findByRole("button", { name: /start focusing/i }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("focus-done-summary")).not.toBeInTheDocument();
    // Announced, not merely implied: a phase change is silent to a screen-reader
    // user, and "did that work?" is the whole question in this moment.
    expect(screen.getByTestId("focus-undone-notice")).toHaveTextContent(
      /open again/i,
    );
  });

  it("also offers it when the completion finished the WHOLE task", async () => {
    // The mis-tap with the most to put right: this branch closed the task and
    // moved the inbox item to Done as well, and it renders a different ending.
    (completeFocus as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      nextStepId: null,
      points: 15,
      googleSynced: false,
      streak: 1,
      freshStart: false,
    });
    const user = userEvent.setup();
    render(
      <FocusTimer
        {...base({
          nextStep: null,
          step: {
            id: "s3",
            text: "Polish",
            estMinutes: 1,
            subtaskEmoji: null,
            order: 3,
            total: 3,
            done: false,
          },
        })}
      />,
    );
    await start(user);
    await user.click(screen.getByRole("button", { name: /complete step/i }));
    await user.click(
      screen.getByRole("button", { name: /actually, i hadn't finished/i }),
    );
    expect(uncompleteStep).toHaveBeenCalledWith("s3");
  });

  it("cancels the auto-advance, so nothing navigates off the rescued step", async () => {
    vi.useFakeTimers();
    try {
      render(<FocusTimer {...base()} />);
      await act(async () => {
        screen.getByRole("button", { name: /start focusing/i }).click();
      });
      await act(async () => {
        screen.getByRole("button", { name: /complete step/i }).click();
      });
      await act(async () => {
        screen
          .getByRole("button", { name: /actually, i hadn't finished/i })
          .click();
      });
      // The countdown lives inside the done block, so returning to `setup`
      // unmounts it. Without that, the five-second timer would keep running and
      // push to the NEXT step — navigating away from the one just rescued, which
      // would make the undo look broken while having worked perfectly.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(AUTO_ADVANCE_SEC * 1000 + 1000);
      });
      expect(push).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  // Duo review round 2, and it was right: the notice sits in the shared
  // setup/running/paused/timeup render tree, not inside a `setup &&` block, and
  // `undone` was never reset — so "Put back. The step is open again." survived
  // pressing Start and kept showing over a live countdown for the same step. The
  // code comment claiming "starting the step again replaces this whole screen"
  // was simply false: it is one component with `phase` toggling inside it.
  it("the notice does not survive starting the step again", async () => {
    const user = userEvent.setup();
    await completeAStep(user);
    await user.click(
      screen.getByRole("button", { name: /actually, i hadn't finished/i }),
    );
    expect(screen.getByTestId("focus-undone-notice")).toBeInTheDocument();
    await start(user);
    expect(screen.queryByTestId("focus-undone-notice")).not.toBeInTheDocument();
  });

  it("a failed undo says the step is STILL done, and keeps the screen it failed on", async () => {
    (uncompleteStep as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("boom"),
    );
    const user = userEvent.setup();
    await completeAStep(user);
    await user.click(
      screen.getByRole("button", { name: /actually, i hadn't finished/i }),
    );
    // Every other failure notice in this component reassures with "nothing is
    // lost". Here that would be a lie — the step really is still marked done —
    // and someone would walk away believing they had recovered work they had not.
    expect(await screen.findByText(/still marked done/i)).toBeInTheDocument();
    expect(screen.queryByTestId("focus-undone-notice")).not.toBeInTheDocument();
    // Still on the done screen, so the Retry in the notice has something to
    // retry and the undo can be pressed again.
    expect(screen.getByTestId("focus-done-summary")).toBeInTheDocument();
  });

  // ── a11y (WCAG 2.4.3), review round 4 ──────────────────────────────────────
  //
  // The undo button lives inside the `done` block, which the return to `setup`
  // unmounts. Nothing handed focus on, so a keyboard or screen-reader user was
  // dropped to <body> at the precise moment they had corrected a mistake and most
  // needed to know where they were — and the only announcement, the polite
  // notice, says the step is open again without saying where "here" now is.
  //
  // The existing hand-offs cover every neighbouring transition and not this one:
  // the #142 effect fires on arrival INTO `done`, and the #66 one on
  // `startingFresh`, which an undo never touches.
  describe("focus after the undo (WCAG 2.4.3)", () => {
    it("hands focus to the setup CTA rather than dropping it to <body>", async () => {
      const user = userEvent.setup();
      await completeAStep(user);
      await user.click(
        screen.getByRole("button", { name: /actually, i hadn't finished/i }),
      );
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: /^start focusing$/i }),
        ).toHaveFocus(),
      );
      expect(document.body).not.toHaveFocus();
    });

    it("lands on Start after an undo that spent a resumable session", async () => {
      // Review round 5 — the post-undo CTA is ALWAYS the Start branch, because the
      // Resume offer is retired by then (see the describe below for why). So this
      // is the only landing site the undo path can produce; `setupCtaRef`'s other
      // call site is exercised by the #66 disclosure test in the single-task
      // block, which is where that branch is actually reachable.
      const user = userEvent.setup();
      render(
        <FocusTimer
          {...base({
            existingSession: {
              id: "sess-paused",
              plannedMin: 10,
              totalSec: 600,
              remainingSec: 300,
            },
          })}
        />,
      );
      await user.click(screen.getByRole("button", { name: /resume/i }));
      await user.click(screen.getByRole("button", { name: /complete step/i }));
      await user.click(
        screen.getByRole("button", { name: /actually, i hadn't finished/i }),
      );
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: /^start focusing$/i }),
        ).toHaveFocus(),
      );
    });

    it("still announces the notice — the focus move does not replace it", async () => {
      // Two separate jobs, and the hand-off must not be mistaken for doing both.
      // The notice is a sibling <p role=status>, not an ancestor of the CTA, so
      // the polite announcement queues rather than being suppressed — the same
      // coexistence the #142 done-summary focus has with the auto-advance panel's
      // live region.
      const user = userEvent.setup();
      await completeAStep(user);
      await user.click(
        screen.getByRole("button", { name: /actually, i hadn't finished/i }),
      );
      const notice = await screen.findByTestId("focus-undone-notice");
      expect(notice).toHaveAttribute("role", "status");
      expect(notice).toHaveTextContent(/open again/i);
      expect(notice).not.toContainElement(
        screen.getByRole("button", { name: /^start focusing$/i }),
      );
      expect(
        screen.getByRole("button", { name: /^start focusing$/i }),
      ).toHaveFocus();
    });

    it("an ordinary arrival at setup steals nothing", async () => {
      // Opening /focus/[stepId] normally lands in `setup` with nothing pressed and
      // nothing unmounted, so moving focus would be the rudeness the hand-off
      // exists to prevent. This is what the `undone` gate buys.
      render(<FocusTimer {...base()} />);
      await waitFor(() => expect(document.body).toHaveFocus());
      expect(
        screen.getByRole("button", { name: /^start focusing$/i }),
      ).not.toHaveFocus();
    });

    it("does not fight the #66 disclosure effect", async () => {
      // The two effects want the same element and must not disarm each other. They
      // cannot collide, because they fire on disjoint deps — `startingFresh` for
      // #66, `undone`/`phase` here — and this pins the half that is checkable
      // without an undo: toggling the disclosure still hands focus over, with the
      // undo effect present and its gate closed (`undone` false).
      const user = userEvent.setup();
      render(
        <FocusTimer
          {...base({
            existingSession: {
              id: "sess-paused",
              plannedMin: 10,
              totalSec: 600,
              remainingSec: 300,
            },
          })}
        />,
      );
      await user.click(screen.getByRole("button", { name: /start fresh/i }));
      expect(
        screen.getByRole("button", { name: /^start focusing$/i }),
      ).toHaveFocus();
      expect(
        screen.queryByTestId("focus-undone-notice"),
      ).not.toBeInTheDocument();
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Review round 5 — the two handlers #139 never reached.
//
// `run()` reports a THROW. A server action that RUNS and answers `ok: false` (or
// `null`) was discarded with a bare `return`, so the button did nothing at all —
// no notice, no state change, nothing announced. That is verbatim the defect #139
// named on `confirmRequeue`: "a failed requeue indistinguishable from a
// successful one".
//
// The trigger was the undo. `undoComplete` returns to `setup` synchronously and
// only then awaits `router.refresh()`, so for that window the screen still
// rendered the page's `existingSession` prop — a FocusSession that
// `completeFocus` had already closed via `closeSession`'s `endedAt`. `resumeFocus`
// filters on `endedAt: null`, so pressing "Resume · ~Xm left" resolved
// `ok: false` and fell straight down the bare return.
// ─────────────────────────────────────────────────────────────────────────────
describe("FocusTimer — a refused resume or start is not a silent no-op (#139)", () => {
  const paused = {
    id: "sess-paused",
    plannedMin: 10,
    totalSec: 600,
    remainingSec: 300,
  };
  const refused = { ok: false, remainingSec: 0, totalSec: 0, plannedMin: 0 };

  it("a resume the server refuses says so, rather than doing nothing", async () => {
    vi.mocked(resumeFocus).mockResolvedValueOnce(refused);
    const user = userEvent.setup();
    render(<FocusTimer {...base({ existingSession: paused })} />);
    await user.click(screen.getByRole("button", { name: /resume/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /couldn't reach the server/i,
    );
    // Still in `setup`, so both the offer and the Retry are there to press. The
    // fail-safe direction matters: a refused resume must not advance the phase to
    // a running session the server does not have.
    expect(screen.getByRole("button", { name: /resume/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^pause$/i })).toBeNull();
  });

  it("offers Retry, not Reload — a returned ok:false proves the deployment is current", async () => {
    // `stale: false`, on the reasoning `confirmRequeue` already records: the action
    // was found and ran, so its id is live and pressing again can legitimately
    // work. A stale-deployment failure is the case that must NOT offer a retry.
    vi.mocked(resumeFocus).mockResolvedValueOnce(refused);
    const user = userEvent.setup();
    render(<FocusTimer {...base({ existingSession: paused })} />);
    await user.click(screen.getByRole("button", { name: /resume/i }));

    expect(
      await screen.findByRole("button", { name: /try again/i }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /reload/i })).toBeNull();
  });

  it("Retry re-runs the resume and starts the session when it works", async () => {
    vi.mocked(resumeFocus).mockResolvedValueOnce(refused);
    const user = userEvent.setup();
    render(<FocusTimer {...base({ existingSession: paused })} />);
    await user.click(screen.getByRole("button", { name: /resume/i }));
    await user.click(await screen.findByRole("button", { name: /try again/i }));

    expect(vi.mocked(resumeFocus)).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(
      screen.getByRole("button", { name: /^pause$/i }),
    ).toBeInTheDocument();
  });

  it("a Start the server cannot satisfy says so too", async () => {
    // The same bare return, one function up: `beginFocus` answers `null` when the
    // step is not in the resolved workspace, and `start()` discarded it. Folded in
    // rather than left for the next review round — same defect, same handler
    // union, same message.
    vi.mocked(beginFocus).mockResolvedValueOnce(null);
    const user = userEvent.setup();
    render(<FocusTimer {...base()} />);
    await user.click(screen.getByRole("button", { name: /^start focusing$/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /couldn't reach the server/i,
    );
    expect(screen.queryByRole("button", { name: /^pause$/i })).toBeNull();
  });
});

// Review round 5, the cause rather than the symptom. Surfacing the failure (above)
// is the defect fixed; this stops the app offering an affordance it already knows
// cannot work, which is the same rule the `stale` flag encodes — see the notice's
// own comment on why a stale failure offers Reload and never Retry.
describe("FocusTimer — a spent session is not offered again (#198)", () => {
  const paused = {
    id: "sess-paused",
    plannedMin: 10,
    totalSec: 600,
    remainingSec: 300,
  };

  it("undoing a resumed session withdraws the Resume offer it just closed", async () => {
    const user = userEvent.setup();
    render(<FocusTimer {...base({ existingSession: paused })} />);
    // The offer is legitimately there to begin with — the non-zero control, so a
    // pass cannot mean "Resume was never rendered at all".
    expect(screen.getByRole("button", { name: /resume/i })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /resume/i }));
    await user.click(screen.getByRole("button", { name: /complete step/i }));
    await user.click(
      screen.getByRole("button", { name: /actually, i hadn't finished/i }),
    );

    // `completeFocus` closed that row, so resuming it can only ever be refused.
    // Offering it anyway is a control the app knows is dead.
    expect(screen.queryByRole("button", { name: /resume/i })).toBeNull();
    expect(
      screen.getByRole("button", { name: /^start focusing$/i }),
    ).toBeInTheDocument();
    // …and the undo is still announced. Withdrawing the offer must not cost the
    // confirmation.
    expect(screen.getByTestId("focus-undone-notice")).toHaveTextContent(
      /open again/i,
    );
  });

  it("withdraws the 'Keep my paused session' toggle too, not just Resume", async () => {
    // Review round 14. Withdrawing the Resume offer left a SECOND control behind:
    // the way back out of the start-fresh disclosure was gated on the raw
    // `existingSession` prop rather than on the new `resumable` semantics. After an
    // undo, `resumable` is null because `sessionId !== null` — so pressing "Keep my
    // paused session" cleared `startingFresh`, `resumable` stayed null anyway, and
    // NOTHING happened. A control the app knows is dead, which is precisely the
    // #139 class the rest of this MR removes.
    const user = userEvent.setup();
    render(<FocusTimer {...base({ existingSession: paused })} />);

    await user.click(screen.getByRole("button", { name: /resume/i }));
    await user.click(screen.getByRole("button", { name: /complete step/i }));
    await user.click(
      screen.getByRole("button", { name: /actually, i hadn't finished/i }),
    );

    // Reveal the disclosure the toggle lives in, if it is offered at all.
    const startFresh = screen.queryByRole("button", { name: /start fresh/i });
    if (startFresh) await user.click(startFresh);

    expect(
      screen.queryByRole("button", { name: /keep my paused session/i }),
    ).toBeNull();
  });

  it("still offers 'Keep my paused session' when it would actually do something", async () => {
    // The non-zero control for the case above: on arrival, with no session resumed,
    // the toggle is real and must survive. Removing a dead control must not cost
    // the live one — that is how a fix for a dead button becomes a missing button.
    const user = userEvent.setup();
    render(<FocusTimer {...base({ existingSession: paused })} />);
    await user.click(screen.getByRole("button", { name: /start fresh/i }));
    const keep = screen.getByRole("button", {
      name: /keep my paused session/i,
    });
    expect(keep).toBeInTheDocument();
    // And pressing it really goes back to the Resume offer, so "present" is not
    // standing in for "works".
    await user.click(keep);
    expect(screen.getByRole("button", { name: /resume/i })).toBeInTheDocument();
  });

  it("the fresh-start route was already safe, and stays safe", async () => {
    // Honest about which mechanism does the work here: `beginFocus` retires any
    // open session on the step, so the prop is just as stale on this route — but
    // `startingFresh` is latched by then and never cleared, so `resumable` was
    // already null without the `sessionId` gate. Pinned anyway, because the two
    // mechanisms answer different questions ("the user asked for a fresh one" vs
    // "the server row is spent") and a future tidy-up that collapses them into one
    // would reopen this on whichever route it dropped.
    const user = userEvent.setup();
    render(<FocusTimer {...base({ existingSession: paused })} />);
    await user.click(screen.getByRole("button", { name: /start fresh/i }));
    await user.click(screen.getByRole("button", { name: /^start focusing$/i }));
    await user.click(screen.getByRole("button", { name: /complete step/i }));
    await user.click(
      screen.getByRole("button", { name: /actually, i hadn't finished/i }),
    );

    expect(screen.queryByRole("button", { name: /resume/i })).toBeNull();
  });

  it("still offers a genuinely paused session on arrival", async () => {
    // The regression guard: the prop exists for exactly this, and #27's decision
    // was to ask rather than silently resume. Nothing above may cost that.
    render(<FocusTimer {...base({ existingSession: paused })} />);
    expect(
      screen.getByRole("button", { name: /resume.*5m.*left/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^start focusing$/i }),
    ).not.toBeInTheDocument();
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

  // #23 safety net: the celebration line is one of a fixed set, picked at
  // random (it used to be rolled during render into a ref — impure render +
  // a ref read during render; it is now picked when the step is completed).
  it("celebrates with a randomly chosen done message", async () => {
    // A full-range draw is the top of the range, which pickOne maps to the
    // LAST entry — the same case this test has always covered, expressed in
    // the unit the code now reads.
    const random = mockCsprngDraw(0xffffffff);
    try {
      const user = userEvent.setup();
      render(<FocusTimer {...base()} />);
      await start(user);
      await user.click(screen.getByRole("button", { name: /complete step/i }));
      expect(
        await screen.findByText("Done and dusted. Proud of you."),
      ).toBeInTheDocument();
    } finally {
      random.mockRestore();
    }
  });

  it("picks a different done message for a different roll", async () => {
    const random = mockCsprngDraw(0); // → first entry
    try {
      const user = userEvent.setup();
      render(<FocusTimer {...base()} />);
      await start(user);
      await user.click(screen.getByRole("button", { name: /complete step/i }));
      expect(await screen.findByText("Nice — step done!")).toBeInTheDocument();
    } finally {
      random.mockRestore();
    }
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
      // #138 — the ladder is 15/30/45/60 now; this step's 10m estimate is no
      // longer a preset, so it splices in as its own chip (the #66 invariant:
      // the offered set always contains the value the ring is showing).
      expect(
        within(group)
          .getAllByRole("button")
          .map((b) => b.textContent),
      ).toEqual(["10m", "15m", "30m", "45m", "60m"]);
      expect(screen.getByRole("button", { name: "10m" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      expect(screen.getByRole("button", { name: "60m" })).toHaveAttribute(
        "aria-pressed",
        "false",
      );
    });

    it("tapping a chip moves the ring AND the minutes Start submits (one source of truth)", async () => {
      const user = userEvent.setup();
      render(<FocusTimer {...base(singleTask)} />);
      await user.click(screen.getByRole("button", { name: "45m" }));
      expect(screen.getByText("45:00")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "45m" })).toHaveAttribute(
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
      expect(beginFocus).toHaveBeenCalledWith("s1", 45);
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
      ).toEqual(["7m", "15m", "30m", "45m", "60m"]);
      expect(screen.getByRole("button", { name: "7m" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    });

    // Duo review (#66): the chips normalize the estimate (floor 1m, whole
    // minutes) but plannedMin used to be seeded from the raw value, so a row
    // the schema doesn't forbid — estMinutes is a plain Int with no CHECK —
    // could leave every chip unpressed and let Start open a 0-minute session.
    it("a 0m estimate (bad data) still preselects the 1m chip and starts a 1m session", async () => {
      const user = userEvent.setup();
      render(
        <FocusTimer
          {...base({
            ...singleTask,
            step: { ...singleTask.step, estMinutes: 0 },
          })}
        />,
      );
      const group = screen.getByRole("group", { name: /focus for/i });
      const pressed = within(group)
        .getAllByRole("button")
        .filter((b) => b.getAttribute("aria-pressed") === "true");
      expect(pressed.map((b) => b.textContent)).toEqual(["1m"]);
      expect(screen.getByText("1:00")).toBeInTheDocument();
      await user.click(
        screen.getByRole("button", { name: /^start focusing$/i }),
      );
      expect(beginFocus).toHaveBeenCalledWith("s1", 1);
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

// ─────────────────────────────────────────────────────────────────────────────
// #137 / #139 — the failure paths.
//
// Both bugs were hit in production on 2026-07-31, and both were invisible to
// the tests above, because every one of them exercises the happy path. A timer
// that never says a server action failed passes all of them.
//
// #137: `startReestimate` had no try/catch, so a rejection left `pending` true
// and the phase stuck on "Claude is re-estimating…" forever — no error, no
// timeout, no way out. `finishComplete` and `confirmRequeue` had the same
// shape. What actually threw was `Failed to find Server Action "…"`: a tab open
// across three prod deploys posted an action id the running deployment no
// longer had.
//
// #139: `confirmRequeue` discarded `requeueFocus`'s `{ok:false}` and showed the
// success screen regardless, and never called `router.refresh()`.
// ─────────────────────────────────────────────────────────────────────────────
describe("FocusTimer — server-action failures (#137, #139)", () => {
  /** Start the 1-minute step and let the clock run out. Fake timers only. */
  async function runToTimeUp() {
    render(<FocusTimer {...base()} />); // step estMinutes = 1 → 60s
    // userEvent is avoided under fake timers (see the alarm suite above): a
    // native click inside act() is what the rest of this file uses.
    await act(async () => {
      screen.getByRole("button", { name: /start focusing/i }).click();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
  }

  /** …then choose "ask Claude", which is what asks for a new estimate (#138
   * renamed this from "Not yet": the keep-going row now answers plain "no"). */
  async function askForNewEstimate() {
    await runToTimeUp();
    await act(async () => {
      screen.getByRole("button", { name: /ask claude/i }).click();
    });
  }

  async function click(name: RegExp) {
    await act(async () => {
      screen.getByRole("button", { name }).click();
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("re-estimate (#137)", () => {
    it("a rejected re-estimate leaves the pending state instead of spinning forever", async () => {
      vi.mocked(proposeNewEstimate).mockRejectedValueOnce(
        new Error("LLM unavailable"),
      );
      await askForNewEstimate();

      expect(screen.queryByText(/claude is re-estimating/i)).toBeNull();
      expect(screen.getByRole("alert")).toHaveTextContent(
        /couldn't get a new estimate/i,
      );
    });

    it("offers Retry and Skip, so a failed session is never a dead end", async () => {
      vi.mocked(proposeNewEstimate).mockRejectedValueOnce(new Error("nope"));
      await askForNewEstimate();

      expect(
        screen.getByRole("button", { name: /try again/i }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: /pick a time myself/i }),
      ).toBeInTheDocument();
    });

    it("Retry re-runs the action and shows the estimate when it works", async () => {
      vi.mocked(proposeNewEstimate)
        .mockRejectedValueOnce(new Error("nope"))
        .mockResolvedValueOnce(35);
      await askForNewEstimate();
      await click(/try again/i);

      expect(vi.mocked(proposeNewEstimate)).toHaveBeenCalledTimes(2);
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.getByRole("spinbutton")).toHaveValue(35);
    });

    it("Skip hands over the number field without another server call", async () => {
      vi.mocked(proposeNewEstimate).mockRejectedValueOnce(new Error("nope"));
      await askForNewEstimate();
      await click(/pick a time myself/i);

      expect(vi.mocked(proposeNewEstimate)).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.getByRole("spinbutton")).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: /requeue/i }),
      ).toBeInTheDocument();
    });

    // WCAG 2.4.3 — the same precedent the #66 disclosure and the #65 coupled
    // transport already set in this component: when a transition unmounts the
    // control that was pressed, hand focus to whatever is now primary.
    it("announces the wait itself, so the spinner is not silent to a screen reader", async () => {
      vi.mocked(proposeNewEstimate).mockReturnValueOnce(
        new Promise<number>(() => {}),
      );
      await askForNewEstimate();

      expect(screen.getByRole("status")).toHaveTextContent(
        /claude is re-estimating/i,
      );
    });

    it("gives the notice's controls ≥44px targets and an aria-describedby reason", async () => {
      vi.mocked(proposeNewEstimate).mockRejectedValueOnce(new Error("nope"));
      await askForNewEstimate();

      const retry = screen.getByRole("button", { name: /try again/i });
      const skip = screen.getByRole("button", { name: /pick a time myself/i });
      expect(retry.className).toMatch(/min-h-\[44px\]/);
      expect(skip.className).toMatch(/min-h-\[44px\]/);
      // Focus moves to the button, which can cut a role="alert" announcement
      // short — so the button carries the reason too.
      const describedBy = retry.getAttribute("aria-describedby");
      expect(describedBy).toBeTruthy();
      expect(document.getElementById(describedBy!)).toHaveTextContent(
        /couldn't get a new estimate/i,
      );
    });

    it("moves focus to the error's primary action rather than dropping it to <body>", async () => {
      vi.mocked(proposeNewEstimate).mockRejectedValueOnce(new Error("nope"));
      await askForNewEstimate();

      expect(screen.getByRole("button", { name: /try again/i })).toHaveFocus();
    });

    // Duo review round 6 (!223) — WCAG 2.4.3 again, on the other side of the
    // press. Retrying used to clear the failure immediately, which unmounted
    // the notice and the button being pressed, dropping focus to <body> for
    // the whole round trip. The notice now stays mounted and the button goes
    // aria-disabled rather than `disabled`, because a `disabled` element also
    // loses focus.
    it("keeps focus on Retry while the retry is in flight", async () => {
      vi.mocked(proposeNewEstimate)
        .mockRejectedValueOnce(new Error("nope"))
        .mockReturnValueOnce(new Promise<number>(() => {}));
      await askForNewEstimate();
      const retry = screen.getByRole("button", { name: /try again/i });
      expect(retry).toHaveFocus();

      await click(/try again/i);
      expect(screen.getByRole("button", { name: /try again/i })).toHaveFocus();
      expect(
        screen.getByRole("button", { name: /try again/i }),
      ).toHaveAttribute("aria-disabled", "true");
      // #218 — the wait is asserted by its text, not by `getByRole("status")`.
      // That query was pinning the MECHANISM (a nested live region), and the
      // mechanism was the bug; the behaviour it stood for — the wait is on
      // screen while the retry runs — is what survives, and the spec below
      // pins how it now reaches a screen reader.
      expect(screen.getByRole("alert")).toHaveTextContent(/trying again/i);
    });

    // #218 — a polite `role="status"` nested inside this assertive `role="alert"`
    // has no defined announcement behaviour: the outer region's politeness
    // applies to its whole subtree, so whether the inner text is read politely,
    // assertively, twice or not at all is down to the screen reader. Nothing
    // live may live inside the notice, and the sighted line stays where it was.
    it("keeps every live region out of the notice, and the wait visibly inside it", async () => {
      vi.mocked(proposeNewEstimate)
        .mockRejectedValueOnce(new Error("nope"))
        .mockReturnValueOnce(new Promise<number>(() => {}));
      await askForNewEstimate();
      await click(/try again/i);

      const notice = screen.getByRole("alert");
      // Nothing polite anywhere in the assertive region's subtree — neither the
      // role nor a bare `aria-live`, which would nest just as unreliably.
      expect(within(notice).queryByRole("status")).toBeNull();
      expect(notice.querySelector("[role='status']")).toBeNull();
      expect(notice.querySelector("[aria-live]")).toBeNull();

      // No visual change: the same text, in the same place, for sighted users.
      expect(notice).toContainElement(
        screen.getByTestId("focus-retrying-visible"),
      );

      // …and it is also reachable from the control that is deliberately still
      // holding focus, alongside the reason it is being retried — the channel
      // that carries the mirror-image case, where focus LANDS on the CTA with a
      // retry already running. Duo round 16: this is the second channel, not
      // the only one; the live region above is what covers the press itself.
      const retry = screen.getByRole("button", { name: /try again/i });
      const ids = (retry.getAttribute("aria-describedby") ?? "").split(/\s+/);
      const announcer = screen.getByTestId("focus-retrying-announcer");
      expect(announcer.id).toBeTruthy();
      expect(ids).toContain(announcer.id);
      const described = ids
        .map((id) => document.getElementById(id)?.textContent ?? "")
        .join(" ");
      expect(described).toMatch(/couldn't get a new estimate/i);
      expect(described).toMatch(/trying again/i);
    });

    // #218, Duo round 16 — `aria-describedby` was doing this on its own, and it
    // cannot. A description is computed when focus LANDS on a control; the
    // retry is pressed on a control that already has focus and deliberately
    // keeps it, so the value gaining `retryingMessageId` mid-flight changes
    // nothing a screen reader re-reads. That is the same "not reliably
    // announced" hole the nested `role="status"` had, moved onto the button.
    //
    // The one spec-defined channel for content that changes while the user is
    // stationary is a live region, so the wait gets a real one — polite,
    // visually hidden, and a SIBLING of the notice rather than a descendant, so
    // it is not the nested-region bug again. It is mounted empty with the
    // notice, because assistive technology announces a *change* to a region
    // already in the accessibility tree and one that arrives with its first
    // message is silent (the same reasoning `inbox-view.tsx`'s move announcer
    // carries).
    it("announces the wait through a polite live region that is a sibling of the notice", async () => {
      vi.mocked(proposeNewEstimate)
        .mockRejectedValueOnce(new Error("nope"))
        .mockReturnValueOnce(new Promise<number>(() => {}));
      await askForNewEstimate();

      // Present and empty BEFORE the wait exists — otherwise the change that is
      // supposed to be announced is the region's own arrival, which is not one.
      const announcer = screen.getByTestId("focus-retrying-announcer");
      expect(announcer).toBeEmptyDOMElement();
      expect(screen.getByRole("alert")).not.toContainElement(announcer);

      await click(/try again/i);

      expect(announcer).toHaveTextContent(/trying again/i);
      expect(announcer).toHaveAttribute("role", "status");
      expect(announcer).toHaveAttribute("aria-live", "polite");
      // Visually hidden, not `hidden`: a live region has to be rendered to be
      // observed, and the sighted copy inside the notice has not moved.
      expect(announcer).toHaveClass("sr-only");
      // Still not nested, which was the whole of #218.
      expect(screen.getByRole("alert")).not.toContainElement(announcer);
    });

    // The other half of the live region: the sentence must exist exactly once in
    // the accessibility tree. The visible copy stays for sighted users but is
    // hidden from assistive technology — otherwise inserting it into the
    // assertive `role="alert"` re-reads the entire notice over the polite
    // announcement, which is the double-announcement #218 set out to remove.
    it("keeps the visible wait out of the accessibility tree, so the notice is not re-read", async () => {
      vi.mocked(proposeNewEstimate)
        .mockRejectedValueOnce(new Error("nope"))
        .mockReturnValueOnce(new Promise<number>(() => {}));
      await askForNewEstimate();
      await click(/try again/i);

      const visible = screen.getByTestId("focus-retrying-visible");
      expect(screen.getByRole("alert")).toContainElement(visible);
      expect(visible).toHaveAttribute("aria-hidden", "true");
      expect(visible).not.toHaveClass("sr-only");

      // Exactly one node carries it to a screen reader, and it is the announcer.
      expect(
        screen.getAllByText(/trying again/i, {
          ignore: "[aria-hidden='true']",
        }),
      ).toEqual([screen.getByTestId("focus-retrying-announcer")]);
    });

    // The other half of the same contract: a description that never retracts
    // would have the button claiming a retry is running long after it stopped.
    it("drops the wait from the button's description once nothing is in flight", async () => {
      vi.mocked(proposeNewEstimate).mockRejectedValueOnce(new Error("nope"));
      await askForNewEstimate();

      const retry = screen.getByRole("button", { name: /try again/i });
      const ids = (retry.getAttribute("aria-describedby") ?? "").split(/\s+/);
      expect(screen.queryByText(/trying again/i)).toBeNull();
      const described = ids
        .map((id) => document.getElementById(id)?.textContent ?? "")
        .join(" ");
      expect(described).toMatch(/couldn't get a new estimate/i);
      expect(described).not.toMatch(/trying again/i);
      // The live region empties with it, so nothing is left claiming a retry is
      // running — and it stays MOUNTED, which is what makes the next press
      // announceable at all.
      expect(
        screen.getByTestId("focus-retrying-announcer"),
      ).toBeEmptyDOMElement();
    });

    it("does not fire a second request when Retry is pressed mid-flight", async () => {
      vi.mocked(proposeNewEstimate)
        .mockRejectedValueOnce(new Error("nope"))
        .mockReturnValueOnce(new Promise<number>(() => {}));
      await askForNewEstimate();
      await click(/try again/i);
      await click(/try again/i);

      // once for the original attempt, once for the retry — not three times
      expect(vi.mocked(proposeNewEstimate)).toHaveBeenCalledTimes(2);
    });

    // The third failure mode: not a rejection, silence. A pod rolling
    // mid-request leaves the request hanging, and an un-timed-out await looks
    // exactly like the original bug from the user's side.
    it("a request that never answers surfaces once the timeout elapses", async () => {
      vi.mocked(proposeNewEstimate).mockReturnValueOnce(
        new Promise<number>(() => {}),
      );
      await askForNewEstimate();
      expect(screen.getByText(/claude is re-estimating/i)).toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(REESTIMATE_TIMEOUT_MS);
      });
      expect(screen.queryByText(/claude is re-estimating/i)).toBeNull();
      expect(screen.getByRole("alert")).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: /try again/i }),
      ).toBeInTheDocument();
    });
  });

  describe("a stale deployment (#137)", () => {
    /** What Next 16's client throws when the action id is from another build. */
    function staleActionError() {
      return Object.assign(
        new Error(
          'Server Action "40bef5efc6c80527f80d35d95a902c7e0bc4056eb0" was not found on the server.',
        ),
        { name: "UnrecognizedActionError" },
      );
    }

    it("says the app updated and offers a reload", async () => {
      vi.mocked(proposeNewEstimate).mockRejectedValueOnce(staleActionError());
      await askForNewEstimate();

      expect(screen.getByRole("alert")).toHaveTextContent(/app updated/i);
      expect(
        screen.getByRole("button", { name: /reload/i }),
      ).toBeInTheDocument();
    });

    // The whole reason for detecting this case: a retry re-posts the same dead
    // action id, so offering one is offering something that cannot work.
    it("does not offer a retry, which could never succeed against a stale bundle", async () => {
      vi.mocked(proposeNewEstimate).mockRejectedValueOnce(staleActionError());
      await askForNewEstimate();

      expect(screen.queryByRole("button", { name: /try again/i })).toBeNull();
    });

    // Skip only reveals the number field; the Requeue behind it is another
    // server action, which would post another dead id and fail identically. So
    // it is withheld here too — the point of detecting this case is to stop
    // offering things that cannot work, not to offer a different one.
    it("does not offer Skip either, since the Requeue behind it would fail too", async () => {
      vi.mocked(proposeNewEstimate).mockRejectedValueOnce(staleActionError());
      await askForNewEstimate();

      expect(
        screen.queryByRole("button", { name: /pick a time myself/i }),
      ).toBeNull();
      // Reload is the only thing on offer, and it has focus.
      expect(screen.getByRole("button", { name: /reload/i })).toHaveFocus();
    });

    it("puts focus on the reload, which is the only thing that can work", async () => {
      vi.mocked(proposeNewEstimate).mockRejectedValueOnce(staleActionError());
      await askForNewEstimate();

      expect(screen.getByRole("button", { name: /reload/i })).toHaveFocus();
    });
  });

  describe("requeue (#139)", () => {
    it("a rejected requeue does not show the success screen", async () => {
      vi.mocked(requeueFocus).mockRejectedValueOnce(new Error("network"));
      await askForNewEstimate();
      await click(/requeue/i);

      expect(screen.queryByText(/bumped to/i)).toBeNull();
      expect(screen.getByRole("alert")).toHaveTextContent(/couldn't save/i);
    });

    // requeueFocus returns {ok:false} on four separate guard failures — session
    // not found, no step, and the two ownership checks. Every one of them used
    // to land on the "🌱 bumped to N min" screen.
    it("an {ok:false} requeue does not show the success screen either", async () => {
      vi.mocked(requeueFocus).mockResolvedValueOnce({ ok: false });
      await askForNewEstimate();
      await click(/requeue/i);

      expect(screen.queryByText(/bumped to/i)).toBeNull();
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });

    it("keeps the number field so a retry does not lose the chosen time", async () => {
      // The estimate is set explicitly rather than leaning on the default mock,
      // so the assertion documents its own precondition (Duo review round 4).
      vi.mocked(proposeNewEstimate).mockResolvedValueOnce(45);
      vi.mocked(requeueFocus).mockResolvedValueOnce({ ok: false });
      await askForNewEstimate();
      expect(screen.getByRole("spinbutton")).toHaveValue(45);
      await click(/requeue/i);

      expect(screen.getByRole("spinbutton")).toHaveValue(45);
    });

    it("a successful requeue refreshes the router, as finishComplete already did", async () => {
      await askForNewEstimate();
      await click(/requeue/i);

      expect(screen.getByText(/bumped to 20 min/i)).toBeInTheDocument();
      expect(refresh).toHaveBeenCalled();
    });
  });

  describe("completing a step (#137)", () => {
    it("a rejected completion keeps the session on screen instead of celebrating", async () => {
      vi.mocked(completeFocus).mockRejectedValueOnce(new Error("boom"));
      await runToTimeUp();
      await click(/^all done$/i);

      expect(screen.queryByText(/step done|that's one off/i)).toBeNull();
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });

    it("re-enables the controls, so the user is not stuck behind a disabled button", async () => {
      vi.mocked(completeFocus).mockRejectedValueOnce(new Error("boom"));
      await runToTimeUp();
      await click(/^all done$/i);

      expect(screen.getByRole("button", { name: /^all done$/i })).toBeEnabled();
      expect(screen.getByRole("button", { name: /ask claude/i })).toBeEnabled();
    });

    it("does not celebrate a completion the server refused", async () => {
      vi.mocked(completeFocus).mockResolvedValueOnce({
        ok: false,
        nextStepId: null,
        points: 0,
        googleSynced: false,
        streak: null,
        freshStart: false,
      });
      await runToTimeUp();
      await click(/^all done$/i);

      expect(screen.getByRole("alert")).toBeInTheDocument();
      expect(screen.queryByText("🎉")).toBeNull();
    });
  });

  describe("starting a session (#137)", () => {
    it("a rejected start leaves the CTA usable instead of permanently disabled", async () => {
      vi.mocked(beginFocus).mockRejectedValueOnce(new Error("boom"));
      render(<FocusTimer {...base()} />);
      await act(async () => {
        screen.getByRole("button", { name: /start focusing/i }).click();
      });

      const cta = screen.getByRole("button", { name: /start focusing/i });
      expect(cta).toBeEnabled();
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
  });
});

// ── #142 — finishing a step no longer dead-ends ────────────────────────
//
// The fake-timer tests here follow the same shape as the alarm block above:
// native `.click()` inside `act`, never userEvent, because userEvent's own
// scheduler interacts awkwardly with fake timers around an async server action.
describe("FocusTimer — auto-advance after a completed step (#142)", () => {
  /** Start → Complete step, on fake timers, leaving the done screen mounted. */
  async function finishOnFakeTimers() {
    await act(async () => {
      screen.getByRole("button", { name: /start focusing/i }).click();
    });
    await act(async () => {
      screen.getByRole("button", { name: /complete step/i }).click();
    });
  }

  it("offers the next step as a countdown, naming where it is going", async () => {
    const user = userEvent.setup();
    render(<FocusTimer {...base()} />);
    await start(user);
    await user.click(screen.getByRole("button", { name: /complete step/i }));
    expect(await screen.findByText("Polish")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/next step/i);
    expect(
      screen.getByRole("button", { name: /stay here/i }),
    ).toBeInTheDocument();
  });

  it("lands on the next step's START screen — it does not begin the next timer", async () => {
    vi.useFakeTimers();
    try {
      render(<FocusTimer {...base()} />);
      await finishOnFakeTimers();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(AUTO_ADVANCE_SEC * 1000);
      });
      expect(push).toHaveBeenCalledWith("/focus/s3");
      // beginFocus was called ONCE — by the step just finished, never by the
      // arrival. Landing mid-countdown on work you have not agreed to is worse
      // than an extra tap.
      expect(beginFocus).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("'Stay here' stops the navigation but keeps the next step reachable", async () => {
    vi.useFakeTimers();
    try {
      render(<FocusTimer {...base()} />);
      await finishOnFakeTimers();
      await act(async () => {
        screen.getByRole("button", { name: /stay here/i }).click();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(push).not.toHaveBeenCalled();
      await act(async () => {
        screen.getByRole("button", { name: /go now/i }).click();
      });
      expect(push).toHaveBeenCalledWith("/focus/s3");
    } finally {
      vi.useRealTimers();
    }
  });

  it("focus lands on the celebration, deliberately, rather than on <body>", async () => {
    const user = userEvent.setup();
    render(<FocusTimer {...base()} />);
    await start(user);
    await user.click(screen.getByRole("button", { name: /complete step/i }));
    await waitFor(() =>
      expect(screen.getByTestId("focus-done-summary")).toHaveFocus(),
    );
  });

  it("respects reduced motion on the countdown", async () => {
    mockReducedMotion = true;
    const user = userEvent.setup();
    const { container } = render(<FocusTimer {...base()} />);
    await start(user);
    await user.click(screen.getByRole("button", { name: /complete step/i }));
    expect(await screen.findByText("Polish")).toBeInTheDocument();
    expect(container.querySelector("[data-auto-advance-progress]")).toBeNull();
  });

  it("the countdown itself is escapable to /focus — 'Stay here' must not trade one dead end for another", async () => {
    const user = userEvent.setup();
    render(<FocusTimer {...base()} />);
    await start(user);
    await user.click(screen.getByRole("button", { name: /complete step/i }));
    await user.click(await screen.findByRole("button", { name: /stay here/i }));
    // Cancelled, so the only things on screen are "Go now" and the way out.
    expect(screen.getByRole("link", { name: /done for now/i })).toHaveAttribute(
      "href",
      "/focus",
    );
  });

  it("no next step → no countdown, and nothing navigates on its own", async () => {
    vi.useFakeTimers();
    try {
      render(<FocusTimer {...base({ nextStep: null })} />);
      await finishOnFakeTimers();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(push).not.toHaveBeenCalled();
      expect(
        screen.queryByRole("button", { name: /stay here/i }),
      ).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── #142 — the end of a task, and the end of everything ──────────────────────
describe("FocusTimer — where a finished TASK goes (#142)", () => {
  /**
   * This jsdom build exposes no `localStorage` (Node's own is gated behind
   * --localstorage-file and shadows jsdom's), so hyper focus mode reads as OFF
   * unless a store is installed. Persistence semantics live in
   * hyper-focus.test.ts; this only needs somewhere for the mode to be true.
   */
  function installStorage(seed?: Record<string, string>) {
    const map = new Map(Object.entries(seed ?? {}));
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      writable: true,
      value: {
        get length() {
          return map.size;
        },
        key: (i: number) => Array.from(map.keys())[i] ?? null,
        getItem: (k: string) => map.get(k) ?? null,
        setItem: (k: string, v: string) => void map.set(k, String(v)),
        removeItem: (k: string) => void map.delete(k),
        clear: () => map.clear(),
      } as Storage,
    });
    return map;
  }

  /** A finished LAST step: no next step in this task. */
  const lastStep = (over: Partial<Parameters<typeof FocusTimer>[0]> = {}) =>
    base({
      nextStep: null,
      step: {
        id: "s3",
        text: "Polish",
        estMinutes: 1,
        subtaskEmoji: null,
        order: 3,
        total: 3,
        done: false,
      },
      ...over,
    });

  const singleTaskDone = (
    over: Partial<Parameters<typeof FocusTimer>[0]> = {},
  ) =>
    lastStep({
      isSingleTask: true,
      taskTitle: "Call the bank",
      step: {
        id: "s1",
        text: "Call the bank",
        estMinutes: 1,
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
          estMinutes: 1,
          subtaskEmoji: null,
        },
      ],
      ...over,
    });

  async function finish(user: ReturnType<typeof userEvent.setup>) {
    await start(user);
    await user.click(screen.getByRole("button", { name: /complete step/i }));
  }

  it("hyper focus ON chains into the next single-task to-do, through the same countdown", async () => {
    installStorage({ "df-hyper-focus": "1" });
    vi.useFakeTimers();
    try {
      render(
        <FocusTimer
          {...singleTaskDone({
            nextUp: { kind: "single", itemId: "i9", text: "Book the dentist" },
          })}
        />,
      );
      await act(async () => {
        screen.getByRole("button", { name: /start focusing/i }).click();
      });
      await act(async () => {
        screen.getByRole("button", { name: /complete step/i }).click();
      });
      expect(screen.getByText("Book the dentist")).toBeInTheDocument();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(AUTO_ADVANCE_SEC * 1000);
      });
      // A to-do has no step until one is created for it, so the chain goes
      // through ensureFocusStep rather than guessing a URL.
      expect(ensureFocusStep).toHaveBeenCalledWith("i9");
      // Flush the action's promise chain. `waitFor` polls on REAL timers and
      // would simply hang here (5s test timeout) with fake ones installed.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(push).toHaveBeenCalledWith("/focus/new-step");
    } finally {
      vi.useRealTimers();
    }
  });

  it("hyper focus OFF returns to /focus after the celebration — nothing navigates on its own", async () => {
    installStorage();
    vi.useFakeTimers();
    try {
      render(
        <FocusTimer
          {...singleTaskDone({
            nextUp: { kind: "single", itemId: "i9", text: "Book the dentist" },
          })}
        />,
      );
      await act(async () => {
        screen.getByRole("button", { name: /start focusing/i }).click();
      });
      await act(async () => {
        screen.getByRole("button", { name: /complete step/i }).click();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(push).not.toHaveBeenCalled();
      expect(
        screen.queryByRole("button", { name: /stay here/i }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole("link", { name: /back to focus/i }),
      ).toHaveAttribute("href", "/focus");
    } finally {
      vi.useRealTimers();
    }
  });

  it("finishing a whole multi-step task offers the next task AND a real stop", async () => {
    installStorage();
    vi.useFakeTimers();
    try {
      render(
        <FocusTimer
          {...lastStep({
            nextUp: {
              kind: "step",
              stepId: "s9",
              text: "Draft the agenda",
              emoji: null,
              taskTitle: "Plan the offsite",
            },
          })}
        />,
      );
      await act(async () => {
        screen.getByRole("button", { name: /start focusing/i }).click();
      });
      await act(async () => {
        screen.getByRole("button", { name: /complete step/i }).click();
      });
      expect(screen.getByText(/task complete/i)).toBeInTheDocument();
      // Offered, never taken automatically: a whole task deserves a real pause.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(push).not.toHaveBeenCalled();
      expect(
        screen.getByRole("link", { name: /focus the next step/i }),
      ).toHaveAttribute("href", "/focus/s9");
      expect(screen.getByText("Plan the offsite")).toBeInTheDocument();
      // …and stopping is a first-class answer, not a link hiding underneath.
      expect(
        screen.getByRole("link", { name: /done for now/i }),
      ).toHaveAttribute("href", "/focus");
    } finally {
      vi.useRealTimers();
    }
  });

  it("an empty multi-step queue offers hyper focus mode, and one press starts the chain", async () => {
    const store = installStorage();
    const user = userEvent.setup();
    render(
      <FocusTimer
        {...lastStep({
          nextUp: { kind: "single", itemId: "i9", text: "Book the dentist" },
        })}
      />,
    );
    await finish(user);
    expect(screen.getByText(/no multi-step tasks left/i)).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: /turn on hyper focus mode/i }),
    );
    expect(store.get("df-hyper-focus")).toBe("1");
    expect(ensureFocusStep).toHaveBeenCalledWith("i9");
    await waitFor(() => expect(push).toHaveBeenCalledWith("/focus/new-step"));
  });

  it("nothing left at all lands on the activity dashboard, not on an empty list", async () => {
    installStorage();
    const user = userEvent.setup();
    render(<FocusTimer {...lastStep({ nextUp: null })} />);
    await finish(user);
    expect(await screen.findByText(/that's everything/i)).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /see how today went/i }),
    ).toHaveAttribute("href", "/dashboard");
  });

  it("a failed chain says so and offers a retry — it does not silently do nothing", async () => {
    // Mode off, so the empty-queue screen is the one offering to turn it on —
    // and pressing that offer is what runs the chain.
    installStorage();
    vi.mocked(ensureFocusStep).mockRejectedValueOnce(new Error("boom"));
    const user = userEvent.setup();
    render(
      <FocusTimer
        {...lastStep({
          nextUp: { kind: "single", itemId: "i9", text: "Book the dentist" },
        })}
      />,
    );
    await finish(user);
    await user.click(
      screen.getByRole("button", { name: /turn on hyper focus mode/i }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(/next to-do/i);
    vi.mocked(ensureFocusStep).mockResolvedValue("new-step");
    await user.click(screen.getByRole("button", { name: /try again/i }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/focus/new-step"));
  });
});

// ── #44 — the jotted context, present while you do the work ─────────────────
//
// The issue asks for the note in the focus session specifically: "the context
// you jotted is right there while you're doing the work". READ-ONLY here, and
// that is the decision — the session exists to remove decisions, and a text
// field with an autosave is an invitation to edit rather than to work. Every
// other surface can edit it.
describe("FocusTimer — the notes for this work (#44)", () => {
  it("shows the task's note", () => {
    render(<FocusTimer {...base({ taskNote: "bring the Figma link" })} />);
    expect(screen.getByText("bring the Figma link")).toBeInTheDocument();
  });

  it("shows the step's own note as well as the task's", () => {
    render(
      <FocusTimer
        {...base({ taskNote: "bring the Figma link", stepNote: "call Sam" })}
      />,
    );
    expect(screen.getByText("bring the Figma link")).toBeInTheDocument();
    expect(screen.getByText("call Sam")).toBeInTheDocument();
  });

  it("renders no note region at all when neither exists", () => {
    render(<FocusTimer {...base()} />);
    expect(screen.queryByTestId("note-text")).toBeNull();
  });

  it("offers no way to EDIT here — no trigger and no textbox", () => {
    render(<FocusTimer {...base({ taskNote: "read only" })} />);
    expect(screen.queryByRole("button", { name: /^note for/i })).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
  });
});
