// Import this first in a test file, then `await import()` the mod code.
import { register } from "node:module";
register("./hooks.mjs", import.meta.url);

// The mod logs every error to the console; keep test output readable.
for (const k of ["log", "error"]) {
  const orig = console[k].bind(console);
  console[k] = (...a) => { if (!String(a[0]).startsWith("[shortcut]")) orig(...a); };
}
