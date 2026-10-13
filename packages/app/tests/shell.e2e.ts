import { expect, test } from "vitest";
import { launch, launchSecond } from "./app.js";

test("the app opens to an empty Projects sidebar", async () => {
  const { page } = await launch();
  await page.getByRole("navigation", { name: "Projects" }).waitFor();
  await page.getByText("No projects yet").waitFor();
  await page.getByRole("button", { name: "Add project" }).waitFor();
});

test("a second launch focuses the existing window and exits", async () => {
  const { app, page, appData } = await launch();
  await page.getByRole("navigation", { name: "Projects" }).waitFor();
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.hide(),
  );
  expect(await launchSecond(appData)).toBe(0);
  await expect
    .poll(() =>
      app.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0];
        return window ? window.isVisible() && window.isFocused() : false;
      }),
    )
    .toBe(true);
});
