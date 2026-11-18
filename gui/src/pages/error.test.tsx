import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Provider } from "react-redux";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MockIdeMessenger } from "../context/MockIdeMessenger";
import { setupStore } from "../redux/store";
import ErrorPage from "./error";

const STACK_MARK = "at Broken (secret-file.tsx:12:3)";

function Broken(): never {
  const e = new Error("Cannot read properties of undefined");
  e.stack = `Error: Cannot read properties of undefined\n    ${STACK_MARK}`;
  throw e;
}

function setup() {
  const store = setupStore({ ideMessenger: new MockIdeMessenger() });
  const router = createMemoryRouter(
    [
      { path: "/", element: <div data-testid="home">home</div> },
      { path: "/broken", element: <Broken />, errorElement: <ErrorPage /> },
    ],
    { initialEntries: ["/broken"] },
  );
  render(
    <Provider store={store}>
      <RouterProvider router={router} />
    </Provider>,
  );
  return { store, user: userEvent.setup() };
}

describe("ErrorPage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("shows the message as an alert, without the stack", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    setup();
    const page = await screen.findByRole("alert");
    expect(page.textContent).toContain("This page could not be shown");
    expect(page.textContent).toContain("Cannot read properties of undefined");
    expect(page.textContent).not.toContain(STACK_MARK);
  });

  it("says what the button does before it is pressed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    setup();
    const button = await screen.findByRole("button", {
      name: "Start a new chat",
    });
    expect(button).toBeTruthy();
    expect(screen.getByTestId("error-page").textContent).toContain(
      "closes the chat that was open in this window and clears the input history",
    );
  });

  it("the button clears the input history and goes back to the chat", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    localStorage.setItem("inputHistory_chat", "[]");
    const { user } = setup();
    await user.click(await screen.findByTestId("error-page-new-chat"));
    expect(localStorage.getItem("inputHistory_chat")).toBeNull();
    expect(await screen.findByTestId("home")).toBeTruthy();
  });
});
