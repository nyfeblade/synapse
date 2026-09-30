import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "host",
    include: ["test/**/*.test.ts"],
    testTimeout: 20_000,
    // One temp root per test file, removed when the file ends (test/setup-tmpdir.ts).
    setupFiles: ["../scripts/vitest-test-home.ts", "test/setup-tmpdir.ts"],
    // The temp-dir and disk guard (bug-log 128); a no-op when the root config already runs it.
    globalSetup: ["../scripts/vitest-disk-guard.ts"],
    // The suite writes through the real atomic writers but does not wait on the device. fsync is a
    // barrier every worker on the machine queues behind (~9.0 ms vs ~1.4 ms per write here, worse
    // the more workers run), which is what made a rotating set of host files time out at 20 s under
    // load and pass in isolation. Atomicity — temp file, then rename — is untouched, and
    // test/util/durable-writes.test.ts keeps the fsync itself covered by switching it back on.
    env: { SYNAPSE_ATOMIC_FSYNC: "off" },
  },
});
