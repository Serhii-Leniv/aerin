import spawn from "cross-spawn";
import { VERSION } from "../version.js";

/** `aerin update` — self-update the global install from npm. */
export async function runUpdate(): Promise<void> {
  let latest: string | undefined;
  try {
    const res = await fetch("https://registry.npmjs.org/aerin-agent/latest", {
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) latest = ((await res.json()) as { version?: string }).version;
  } catch {
    // registry unreachable — try the install anyway
  }

  if (latest && latest === VERSION) {
    process.stdout.write(`aerin v${VERSION} is already the latest version.\n`);
    return;
  }
  process.stdout.write(
    latest ? `updating aerin v${VERSION} → v${latest}…\n` : `updating aerin v${VERSION} → latest…\n`,
  );

  const exitCode = await new Promise<number>((resolve) => {
    const child = spawn("npm", ["install", "-g", "aerin-agent@latest"], {
      stdio: "inherit",
      windowsHide: true,
    });
    child.on("error", () => resolve(1));
    child.on("exit", (code) => resolve(code ?? 1));
  });

  if (exitCode === 0) {
    process.stdout.write(`✓ updated${latest ? ` to v${latest}` : ""} — restart aerin to use it.\n`);
  } else {
    process.stderr.write(
      `update failed (exit ${exitCode}). Try manually: npm install -g aerin-agent@latest\n`,
    );
    process.exitCode = 1;
  }
}
