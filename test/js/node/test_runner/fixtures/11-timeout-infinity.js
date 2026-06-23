// node-test.test.ts runs this with `--timeout 100`: an explicit Infinity
// timeout (Node's "no timeout") must override the runner's per-test default.
const { test } = require("node:test");

test("an Infinity timeout overrides the runner default", { timeout: Infinity }, async () => {
  await new Promise(resolve => setTimeout(resolve, 300));
});
