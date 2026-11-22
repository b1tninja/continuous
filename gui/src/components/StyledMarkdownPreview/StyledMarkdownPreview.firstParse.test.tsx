import { render, waitFor } from "@testing-library/react";
import { Provider } from "react-redux";
import { describe, expect, it } from "vitest";
import { setupStore } from "../../redux/store";
import StyledMarkdownPreview from "./index";

/**
 * The transcript measures a row as it mounts. A message whose markdown arrived
 * in a later commit was measured empty, so the first commit must hold it.
 */
describe("StyledMarkdownPreview: the first parse", () => {
  it("has the rendered markdown in the commit that mounts it", () => {
    const { container } = render(
      <Provider store={setupStore({})}>
        <StyledMarkdownPreview
          source={"Some **bold** text\n\n```ts\nconst a = 1;\n```\n"}
        />
      </Provider>,
    );
    // No await: this is what a layout effect of the row would see
    expect(container.querySelector("strong")?.textContent).toBe("bold");
    expect(container.querySelector("pre code.hljs")).toBeTruthy();
    expect(container.querySelector(".hljs-keyword")?.textContent).toBe("const");
  });

  it("follows the source after that, as a streamed reply does", async () => {
    const store = setupStore({});
    const view = render(
      <Provider store={store}>
        <StyledMarkdownPreview source="first" />
      </Provider>,
    );
    expect(view.container.textContent).toContain("first");
    view.rerender(
      <Provider store={store}>
        <StyledMarkdownPreview source="first and *second*" />
      </Provider>,
    );
    await waitFor(() =>
      expect(view.container.querySelector("em")?.textContent).toBe("second"),
    );
    expect(view.container.textContent).toContain("first and second");
  });

  it("shows nothing for an empty source and fills in when text arrives", async () => {
    const store = setupStore({});
    const view = render(
      <Provider store={store}>
        <StyledMarkdownPreview source="" />
      </Provider>,
    );
    expect(view.container.textContent).toBe("");
    view.rerender(
      <Provider store={store}>
        <StyledMarkdownPreview source="now there is text" />
      </Provider>,
    );
    await waitFor(() =>
      expect(view.container.textContent).toContain("now there is text"),
    );
  });
});
