import { expect, test } from "bun:test";
import { bootstrapResponses } from "./bootstrap";

test("generated /docs survives HTML tag sanitization without losing protocol text", async () => {
  const res = bootstrapResponses()(new Request("https://server.invalid/docs"));
  if (!res) throw new Error("Missing generated /docs response");
  expect(res.status).toBe(200);
  const text = await res.text();
  // Agent fetch pipelines can strip HTML-looking tags even inside Markdown code fences.
  expect(text).not.toMatch(/<[^<>\s][^<>]*>/);
});
