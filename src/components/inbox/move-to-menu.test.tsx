// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MoveToMenu } from "./move-to-menu";

afterEach(cleanup);

describe("MoveToMenu", () => {
  it("opens and lists the other buckets, excluding the current one", async () => {
    render(<MoveToMenu currentBucket="singleTask" voice="plain" onMove={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Move to…" }));
    expect(screen.getByRole("menuitem", { name: /Needs review/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Multi-step/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Saved for later/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Completed/ })).toBeInTheDocument();
    // current bucket is excluded
    expect(screen.queryByRole("menuitem", { name: /Single-task/ })).not.toBeInTheDocument();
  });

  it("calls onMove with the chosen bucket id", async () => {
    const onMove = vi.fn();
    render(<MoveToMenu currentBucket="singleTask" voice="plain" onMove={onMove} />);
    await userEvent.click(screen.getByRole("button", { name: "Move to…" }));
    await userEvent.click(screen.getByRole("menuitem", { name: /Completed/ }));
    expect(onMove).toHaveBeenCalledWith("completed");
  });

  it("Escape closes the open menu", async () => {
    render(<MoveToMenu currentBucket="singleTask" voice="plain" onMove={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Move to…" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("clicking outside closes the menu without moving", async () => {
    const onMove = vi.fn();
    render(
      <div>
        <button type="button">outside</button>
        <MoveToMenu currentBucket="singleTask" voice="plain" onMove={onMove} />
      </div>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Move to…" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "outside" }));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(onMove).not.toHaveBeenCalled();
  });
});
