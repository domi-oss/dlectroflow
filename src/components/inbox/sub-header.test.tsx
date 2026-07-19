// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { SubHeader, SEE_ALL } from "@/components/inbox/sub-header";

afterEach(cleanup);

describe("SubHeader", () => {
  it("renders label, count pill, and a see-all link to the given href", () => {
    render(<SubHeader label="Single-task to-dos" count={3} seeAllHref={SEE_ALL.singleTask} voice="plain" />);
    expect(screen.getByText("Single-task to-dos")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /see all/i });
    expect(link).toHaveAttribute("href", "/library?tab=plated");
  });

  it("exposes the canonical deep-link hrefs", () => {
    expect(SEE_ALL.singleTask).toBe("/library?tab=plated");
    expect(SEE_ALL.multiStep).toBe("/library?tab=sorted");
  });
});
