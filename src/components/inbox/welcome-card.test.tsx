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
    expect(screen.getByText("👋 Welcome to dlectroflow")).toBeInTheDocument();
    expect(
      screen.getByText(/Jot anything on your mind in the box below/),
    ).toBeInTheDocument();
  });

  // ── v2: quick links speak the app's own section-title vocabulary ──────────
  it("links to the Library using the app's plain section label (Everything)", () => {
    render(<WelcomeCard voice="plain" />);
    expect(screen.getByRole("link", { name: /Everything/ })).toHaveAttribute(
      "href",
      "/library",
    );
  });

  it("links to the Library using the playful section label (Larder)", () => {
    render(<WelcomeCard voice="playful" />);
    expect(screen.getByRole("link", { name: /Larder/ })).toHaveAttribute(
      "href",
      "/library",
    );
  });

  it("links to Focus using the plain nav label (Focus Timer)", () => {
    render(<WelcomeCard voice="plain" />);
    expect(screen.getByRole("link", { name: /Focus Timer/ })).toHaveAttribute(
      "href",
      "/focus",
    );
  });

  it("links to Focus using the playful nav label (Focus Timer)", () => {
    render(<WelcomeCard voice="playful" />);
    expect(screen.getByRole("link", { name: /Focus Timer/ })).toHaveAttribute(
      "href",
      "/focus",
    );
  });

  it("renders a Help link to /help with the clearer v2 copy", () => {
    render(<WelcomeCard voice="plain" />);
    expect(
      screen.getByRole("link", { name: "View the help page for more →" }),
    ).toHaveAttribute("href", "/help");
  });

  it("keeps the Help copy identical in playful voice", () => {
    render(<WelcomeCard voice="playful" />);
    expect(
      screen.getByRole("link", { name: "View the help page for more →" }),
    ).toHaveAttribute("href", "/help");
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
