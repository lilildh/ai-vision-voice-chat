import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { App } from "./App";

describe("App", () => {
  it("renders the scaffold status", () => {
    render(<App />);

    expect(
      screen.getByRole("heading", { name: "AI 视觉语音对话应用" })
    ).toBeInTheDocument();
    expect(screen.getByText("脚手架已启动")).toBeInTheDocument();
  });
});
