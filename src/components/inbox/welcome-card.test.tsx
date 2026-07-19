// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WelcomeCard } from "./welcome-card";

const push = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh }),
}));

vi.mock("@/app/actions/settings", () => ({
  dismissWelcome: vi.fn().mockResolvedValue(undefined),
  updateVoice: vi.fn().mockResolvedValue(undefined),
}));

import { dismissWelcome } from "@/app/actions/settings";

afterEach(cleanup);

describe("WelcomeCard", () => {
  it("opens with the greeting in the body (👋); the separate title heading is dropped", () => {
    render(<WelcomeCard voice="plain" />);
    const body = screen.getByText(/Welcome to dlectroflow, you are in the inbox/);
    expect(body).toBeInTheDocument();
    expect(body.textContent).toContain("👋");
    // No standalone <h2> title any more — the greeting lives in the body.
    expect(
      screen.queryByRole("heading", { name: /Welcome to dlectroflow/ }),
    ).toBeNull();
  });

  // ── Links are embedded INLINE in the body sentences (no separate row) ──────
  it("embeds the Focus Timer link (→ /focus)", () => {
    render(<WelcomeCard voice="plain" />);
    expect(screen.getByRole("link", { name: "Focus Timer" })).toHaveAttribute(
      "href",
      "/focus",
    );
  });

  it("embeds the Library link (→ /library) with the plain label", () => {
    render(<WelcomeCard voice="plain" />);
    expect(screen.getByRole("link", { name: "Library" })).toHaveAttribute(
      "href",
      "/library",
    );
  });

  it("embeds the Library link with the playful label (Larder → /library)", () => {
    render(<WelcomeCard voice="playful" />);
    expect(screen.getByRole("link", { name: "Larder" })).toHaveAttribute(
      "href",
      "/library",
    );
  });

  it("embeds only 'Help section' as the /help link", () => {
    render(<WelcomeCard voice="plain" />);
    expect(screen.getByRole("link", { name: "Help section" })).toHaveAttribute(
      "href",
      "/help",
    );
  });

  it("renders both voice options", () => {
    render(<WelcomeCard voice="plain" />);
    expect(screen.getByRole("button", { name: "Plain" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Playful" })).toBeInTheDocument();
  });

  it("calls dismissWelcome when the Dismiss button is clicked", async () => {
    render(<WelcomeCard voice="plain" />);
    await userEvent.click(screen.getByRole("button", { name: "Got it" }));
    expect(dismissWelcome).toHaveBeenCalledTimes(1);
  });
});
