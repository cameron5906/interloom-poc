import { expect, test } from "@playwright/test";

test("unbound Host renders its safe operator bootstrap surface", async ({ page, request }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });

  const health = await request.get("/livez");
  expect(health.ok()).toBe(true);

  const response = await page.goto("/");
  expect(response?.ok()).toBe(true);
  await expect(page.locator("body")).not.toBeEmpty();
  await expect(page.locator("body")).toContainText(/operator|interloom|agent host/i);
  expect(errors).toEqual([]);
});
