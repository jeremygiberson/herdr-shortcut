import "./helpers/setup.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { open, texts } from "./helpers/view.mjs";
test("the popup renders its title", async () => {
  const { v } = await open({ routes: { "GET /member": { status: 401, body: { message: "Unauthorized" } } } });
  assert.match(texts(v), /Shortcut/);
});
