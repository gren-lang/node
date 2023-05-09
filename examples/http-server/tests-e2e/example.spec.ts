import { test, expect } from "@playwright/test";
import * as fs from "fs";

test("responding with custom body", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Welcome!")).toBeVisible();

  await page.goto("/hello");
  await expect(page.getByText("Hello to you too!")).toBeVisible();
});

test("responding with custom status", async ({ page }) => {
  let response = await page.goto("/");
  let response2 = await page.goto("/not/found");

  await expect(response?.status()).toBe(200);
  await expect(response2?.status()).toBe(404);
});

test("setting custom headers", async ({ page }) => {
  let response = await page.goto("/");
  let headerValue = await response?.headerValue("X-Custom-Header");
  await expect(headerValue).toBe("hey there");
});

test("responding to non-GET requests", async ({ request }) => {
  let response = await request.post("/", { data: "some data" });
  await expect(response.headers()["content-type"]).toBe("text/html");
  await expect(await response.text()).toContain("You posted: some data");

  response = await request.put("/howdy");
  await expect(response.headers()["content-type"]).toBe("text/html");
  await expect(await response.text()).toContain("PUT /howdy");
});

test("handling json", async ({ request }) => {
  let response = await request.post("/name", { data: { name: "Jane" } });
  await expect(await response.text()).toContain("Hello, Jane");
});

test("responding to stream requests", async ({ request }) => {
  let response = await request.post("/", {
    multipart: {
      fileField: {
        name: "test.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("abc123"),
      },
    },
  });

  await expect(response?.status()).toBe(200);
  await expect(await response.text()).toContain("test.txt");
  await expect(await response.text()).toContain("abc123");
});

test("handling unicode", async ({ request }) => {
  let response = await request.post("/", { data: "snow ❄ flake" });
  await expect(response.headers()["content-type"]).toBe("text/html");
  await expect(await response.text()).toContain("You posted: snow ❄ flake");
});
