import { main } from "./cli.js";

void main(process.argv).finally(() => {
  // Teardown is fully awaited inside main(). Release stdin so a clean loop
  // exits naturally (a hard process.exit here races libuv handle teardown on
  // Windows); if some stray handle still holds the loop, force out shortly.
  process.stdin.pause();
  try {
    process.stdin.unref();
  } catch {
    // not all stdin types support unref
  }
  setTimeout(() => process.exit(process.exitCode ?? 0), 1500).unref();
});
