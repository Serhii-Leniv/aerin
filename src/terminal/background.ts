/**
 * Terminal background detection (opencode-style): ask the terminal for its
 * background color via OSC 11 and classify it light or dark, so the palette
 * can adapt. Falls back to the COLORFGBG convention, then to dark. Best
 * effort — a terminal that never answers costs one 250ms startup wait.
 */

function envFallback(): boolean {
  // COLORFGBG is "fg;bg" (sometimes "fg;default;bg"); bg 7 or 9-15 is light.
  const bg = Number(process.env["COLORFGBG"]?.split(";").pop());
  return Number.isFinite(bg) && (bg === 7 || bg >= 9);
}

/**
 * Classify an OSC 11 reply ("\x1b]11;rgb:ffff/ffff/ffff", channels 1-4 hex
 * digits, BEL or ST terminated) as light (true) / dark (false); undefined
 * while no complete reply is present. Exported for tests.
 */
export function parseOsc11(buf: string): boolean | undefined {
  const m = /\]11;rgba?:([0-9a-f]+)\/([0-9a-f]+)\/([0-9a-f]+)/i.exec(buf);
  if (!m) return undefined;
  const chan = (h: string): number => parseInt(h, 16) / (16 ** h.length - 1);
  const lum = 0.2126 * chan(m[1]!) + 0.7152 * chan(m[2]!) + 0.0722 * chan(m[3]!);
  return lum > 0.55;
}

export async function detectLightBackground(): Promise<boolean> {
  const { stdin, stdout } = process;
  if (!stdin.isTTY || !stdout.isTTY) return envFallback();
  return new Promise((resolve) => {
    let buf = "";
    let settled = false;
    const done = (v: boolean | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stdin.off("data", onData);
      stdin.pause();
      stdin.setRawMode(false);
      resolve(v ?? envFallback());
    };
    const onData = (d: Buffer): void => {
      buf += d.toString("latin1");
      const light = parseOsc11(buf);
      if (light !== undefined) done(light);
    };
    const timer = setTimeout(() => done(undefined), 250);
    try {
      stdin.setRawMode(true);
      stdin.resume();
      stdin.on("data", onData);
      stdout.write("\x1b]11;?\x07");
    } catch {
      done(undefined);
    }
  });
}
