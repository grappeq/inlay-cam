// Opening the pairing link in the default browser, so that inlay_open can
// bring up a page that is already paired with this relay.

import { spawn } from "node:child_process";

/** A link safe to hand to the shell that opens it: http(s), and none of the characters cmd.exe reads inside quotes. */
const SAFE = /^https?:\/\/[\w.:/#=?&~-]+$/;

/** The program and its arguments that open `url` in the default browser. */
export function openCommand(url, platform = process.platform) {
  // `start` is cmd's; its first quoted argument is a window title, hence "".
  if (platform === "win32") return { command: "cmd", args: ["/d", "/c", "start", '""', `"${url}"`], verbatim: true };
  if (platform === "darwin") return { command: "open", args: [url], verbatim: false };
  return { command: "xdg-open", args: [url], verbatim: false };
}

/** Opens `url` in the default browser. Resolves true once the opener has started, false when it could not be. */
export function openInBrowser(url, platform = process.platform) {
  if (!SAFE.test(url)) return Promise.resolve(false);
  const { command, args, verbatim } = openCommand(url, platform);
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { stdio: "ignore", detached: true, windowsHide: true, windowsVerbatimArguments: verbatim });
    } catch {
      resolve(false);
      return;
    }
    child.once("error", () => resolve(false));
    child.once("spawn", () => {
      child.unref();
      resolve(true);
    });
  });
}
