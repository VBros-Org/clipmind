import { expect, test } from "@playwright/test";

const accessCode = process.env.CLIPMIND_E2E_ACCESS_CODE ?? "cm-e2e-access";

test("seeded creator can log in and open Home, Review, and Rhythm", async ({
  page,
}) => {
  await page.goto("/login");

  await expect(page.getByRole("heading", { name: "ClipMind" })).toBeVisible();
  await page.getByLabel("Creator code").fill(accessCode);
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page).toHaveURL(/\/home$/);
  await expect(page.getByTestId("bottom-tab-bar")).toBeVisible();
  await expect(page.getByTestId("runway-hero")).toBeVisible();

  await page.getByRole("link", { name: /Review/ }).click();
  await expect(page).toHaveURL(/\/review$/);
  await expect(page.getByRole("heading", { name: "Judge clips" })).toBeVisible();
  await expect(page.getByTestId("clip-card").first()).toBeVisible();
  await expect(page.getByText("Clips are ordered by Mind rank.")).toBeVisible();

  await page.getByRole("link", { name: /Rhythm/ }).click();
  await expect(page).toHaveURL(/\/rhythm$/);
  await expect(
    page.getByRole("heading", { name: "Posting cadence" }),
  ).toBeVisible();
  await expect(page.getByTestId("cadence-preview")).toBeVisible();
  await expect(page.getByText("E2E Creator")).toBeVisible();
});
