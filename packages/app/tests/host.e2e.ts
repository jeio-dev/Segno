import { join } from "node:path";
import { expect, test } from "vitest";
import {
  examples,
  hostPid,
  launch,
  repoWithRemote,
  stubDialog,
} from "./app.js";

const validConfig = {
  schemaVersion: 1,
  baseBranch: "main",
  tests: { command: "pnpm test" },
  roles: {
    coder: { adapter: "claude-code", model: "sonnet" },
    reviewer: { adapter: "claude-code", model: "opus" },
  },
};

test("a killed host is restarted once with the board unchanged; a second death offers Restart Engine", async () => {
  const { app, page } = await launch();
  const repo = repoWithRemote({
    "segno.config.json": `${JSON.stringify(validConfig)}\n`,
  });
  await stubDialog(app, "showOpenDialog", {
    canceled: false,
    filePaths: [repo],
  });
  await page.getByRole("button", { name: "Add project" }).click();
  await page.getByRole("button", { name: "Choose folder…" }).click();
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await stubDialog(app, "showOpenDialog", {
    canceled: false,
    filePaths: [join(examples, "two-phase.yaml")],
  });
  await page.getByRole("button", { name: "Submit Plan file…" }).click();
  const panel = page.getByRole("complementary", { name: "Awaiting you" });
  await panel.getByText("plan-approval").waitFor();

  const first = await hostPid(app);
  expect(first).toBeTypeOf("number");
  process.kill(first as number, "SIGKILL");
  await expect.poll(() => hostPid(app)).not.toBe(first);
  await expect.poll(() => hostPid(app)).toBeTypeOf("number");
  await page.getByText("Reconnecting…").waitFor({ state: "detached" });
  await panel.getByText("plan-approval").waitFor();

  // Approving through the restarted host only shows if the stream resumed.
  await panel.getByRole("button", { name: "Review plan" }).click();
  await page.getByRole("button", { name: "Approve" }).click();
  const title = page.getByRole("heading", { name: "Search saved notes" });
  await title.waitFor();
  await page.getByText("active", { exact: true }).waitFor();

  const second = await hostPid(app);
  process.kill(second as number, "SIGKILL");
  const restart = page.getByRole("button", { name: "Restart Engine" });
  await restart.waitFor();
  await restart.click();
  await expect.poll(() => hostPid(app)).toBeTypeOf("number");
  await page.getByRole("alert").filter({ hasText: "Restart Engine" }).waitFor({
    state: "detached",
  });
  await title.waitFor();
});
