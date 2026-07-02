import { expect, test } from "bun:test";
import { bunEnv, bunExe, isDebug, tempDir } from "harness";

// A net.Socket's implicit once('connect') listener must become collectable as
// soon as the event has fired: one explicit gc() plus one setImmediate has to
// be enough to observe the collection, every time.
//
// Regression: the event loop dispatched timer/immediate callbacks over stack
// memory still holding JSValues from the earlier, deeper socket-event dispatch.
// Never-written holes in the new dispatch frames (struct padding, unused
// locals) then read as pointers into dead cells, and the conservative root
// scan re-marked the listener on every gc() issued from such a callback, so
// the listener was never collected (every linux-x64-musl CI build between
// 2026-06-28 and this fix). The event loop now zeroes the stack window its
// dispatch frames are built in before each dispatch phase
// (JSC__VM__sanitizeStack).
//
// Whether a dead listener's stack remnant lines up with a hole in a dispatch
// frame depends on the frame layout AND on the process's initial stack
// alignment, which the size of the environment block determines. So the test
// runs the fixture in several child processes whose environment is padded by
// increasing amounts: on an unfixed build, some alignment makes the retention
// deterministic for that child; with the fix, every alignment collects.
// This is the scenario of test/js/node/test/parallel/test-net-connect-memleak.js.
// https://github.com/oven-sh/bun/issues/33044
const fixture = String.raw`
  const net = require("net");
  const assert = require("assert");

  const ROUNDS = 4;
  let done = 0;
  // The registry must outlive every round (a collected registry never runs its
  // cleanup callbacks). The held value is a per-round callback.
  const registry = new FinalizationRegistry(ongc => ongc());

  function round() {
    const server = net.createServer(() => {}).listen(0, () => {
      let collected = false;
      // Created OUTSIDE the block below: a held value must not share a scope
      // with the registration target or the registry itself keeps it alive.
      const onCollected = () => {
        collected = true;
      };
      // Block scope: after 'connect' fires and the once() listener is removed,
      // nothing should reference gcObject.
      {
        const gcObject = {};
        registry.register(gcObject, onCollected);
        const sock = net.createConnection(server.address().port, () => {
          assert.strictEqual(gcObject, gcObject); // keep gcObject alive until here
          assert.strictEqual(collected, false);
          setImmediate(check, sock);
        });
      }
      function check(sock) {
        globalThis.gc();
        setImmediate(() => {
          assert.strictEqual(collected, true, "round " + done + ": the connect listener was not collected by one gc()");
          sock.end();
          server.close(() => {
            if (++done === ROUNDS) console.log("collected " + done + "/" + ROUNDS);
            else round();
          });
        });
      }
    });
  }
  round();
`;

// Debug (ASAN) children are much slower to start, so probe fewer alignments
// there; the release lanes carry the wide sweep.
const alignments = isDebug ? 2 : 16;
const batch = 4;

test("a fired once('connect') listener is collected by a single explicit gc()", async () => {
  using dir = tempDir("connect-listener-gc", { "fixture.js": fixture });

  const run = async (i: number) => {
    await using proc = Bun.spawn({
      cmd: [bunExe(), "--expose-gc", "fixture.js"],
      // The padding changes only the size of the child's environment block,
      // which shifts its initial stack pointer (see the comment at the top).
      env: { ...bunEnv, BUN_TEST_STACK_ALIGNMENT_PAD: "x".repeat(1 + i * 13) },
      cwd: String(dir),
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    return { pad: i, stdout: stdout.trim(), stderr: exitCode === 0 ? "" : stderr, exitCode };
  };

  const results: Awaited<ReturnType<typeof run>>[] = [];
  for (let i = 0; i < alignments; i += batch) {
    const wave = [];
    for (let j = i; j < Math.min(i + batch, alignments); j++) wave.push(run(j));
    results.push(...(await Promise.all(wave)));
  }

  expect(results).toEqual(
    Array.from({ length: alignments }, (_, pad) => ({
      pad,
      stdout: "collected 4/4",
      stderr: "",
      exitCode: 0,
    })),
  );
});
