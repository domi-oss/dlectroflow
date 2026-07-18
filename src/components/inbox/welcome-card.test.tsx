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
  it("renders the welcome title and body", () => {
    render(<WelcomeCard voice="plain" />);
    expect(
      screen.getByText("👋 Welcome to dlectroflow"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Jot anything on your mind in the box below/),
    ).toBeInTheDocument();
  });

  it("renders a link to /help", () => {
    render(<WelcomeCard voice="plain" />);
    expect(screen.getByRole("link", { name: "How it works →" })).toHaveAttribute(
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
