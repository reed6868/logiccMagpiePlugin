// Private, explicit browser sign-in only. Based on the isolated-browser
// patterns in magpie-community/plugins (Agnes, Gemini Web, MClaw; MIT).
// Never attach to an existing browser, expose a debugging port, or read
// any personal browser profile. Only the Logicc sign-in is inspected.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { APP, validCookie, validSession } from "./auth.mjs";

export function findBrowser(platform = process.platform, env = process.env) {
  const home = env.HOME ?? "";
  const paths = platform === "darwin" ? [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    join(home, "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
  ] : platform === "win32" ? [
    join(env.PROGRAMFILES ?? "", "Google/Chrome/Application/chrome.exe"),
    join(env["PROGRAMFILES(X86)"] ?? "", "Google/Chrome/Application/chrome.exe"),
    join(env.LOCALAPPDATA ?? "", "Google/Chrome/Application/chrome.exe"),
    join(env.PROGRAMFILES ?? "", "Microsoft/Edge/Application/msedge.exe"),
    join(env["PROGRAMFILES(X86)"] ?? "", "Microsoft/Edge/Application/msedge.exe"),
  ] : [
    "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium",
    "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge", "/snap/bin/chromium",
  ];
  return [env.LOGICC_BROWSER, ...paths].find(p => p && existsSync(p)) ?? "";
}

export function browserPrerequisites() {
  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    throw new Error("No graphical session detected; use the manual sign-in method.");
  }
  const binary = findBrowser();
  if (!binary) throw new Error("Chrome/Chromium/Edge was not found; set LOGICC_BROWSER or use manual sign-in.");
  return binary;
}

class Pipe {
  constructor(child) {
    this.child = child;
    this.pending = new Map();
    this.sequence = 0;
    this.closed = false;
    this.buffer = "";
    this.decoder = new StringDecoder("utf8");
    child.stdio[4].on("data", chunk => {
      this.buffer += this.decoder.write(chunk);
      if (this.buffer.length > 2 * 1024 * 1024) { this.fail(); return; }
      let end;
      while ((end = this.buffer.indexOf("\0")) >= 0) {
        const line = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 1);
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        const call = this.pending.get(msg.id);
        if (!call) continue;
        this.pending.delete(msg.id);
        clearTimeout(call.timer);
        if (msg.error) call.reject(new Error("Browser sign-in command failed."));
        else call.resolve(msg.result);
      }
    });
    for (const stream of [child.stdio[3], child.stdio[4]]) stream.on("error", () => this.fail());
    child.once("error", () => this.fail());
    child.once("exit", () => this.fail());
  }
  fail() {
    this.closed = true;
    for (const { timer, reject } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error("Private browser closed or disconnected."));
    }
    this.pending.clear();
  }
  send(method, params = {}, sessionId) {
    if (this.closed) return Promise.reject(new Error("Private browser closed."));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Private browser command timed out."));
      }, 3_000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.child.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0");
      } catch {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new Error("Private browser command failed."));
      }
    });
  }
}

function appTarget(target) {
  try { return target.type === "page" && new URL(target.url).origin === APP; }
  catch { return false; }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function browserSignIn({ signal, timeoutMs = 300_000, binary = browserPrerequisites() } = {}) {
  if (signal?.aborted) throw new Error("Logicc sign-in cancelled.");
  const profile = mkdtempSync(join(tmpdir(), "logicc-signin-"));
  chmodSync(profile, 0o700);
  let child, pipe;
  const abort = () => { try { child?.kill("SIGTERM"); } catch {} };
  const deadline = Date.now() + timeoutMs;
  try {
    child = spawn(binary, [
      "--user-data-dir=" + profile,
      "--remote-debugging-pipe",
      "--no-first-run", "--no-default-browser-check", "--disable-sync",
      "--disable-default-apps", "--disable-background-mode", "--new-window", APP,
    ], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
    pipe = new Pipe(child);
    signal?.addEventListener("abort", abort, { once: true });
    while (Date.now() < deadline && !signal?.aborted && !pipe.closed) {
      let session;
      try {
        const { targetInfos } = await pipe.send("Target.getTargets");
        const target = targetInfos.find(appTarget);
        if (target) {
          const attached = await pipe.send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
          session = attached.sessionId;
          // The user signs into the new browser themselves. Wait for the
          // Logicc page's Clerk SDK to identify an active session.
          const { result } = await pipe.send("Runtime.evaluate", {
            expression: "window.Clerk?.session?.id ?? null",
            returnByValue: true,
          }, session);
          const sid = result?.value;
          if (validSession(sid)) {
            const { cookies } = await pipe.send("Network.getCookies", {
              urls: ["https://clerk.logicc.com/v1/client/sessions/" + encodeURIComponent(sid) + "/tokens"],
            }, session);
            const values = [...new Set(cookies.filter(c => c.name === "__client" &&
              ["clerk.logicc.com", "logicc.com"].includes(c.domain.replace(/^\./, "")) &&
              validCookie(c.value)).map(c => c.value))];
            if (values.length === 1) return { cookie: values[0], sid };
          }
        }
      } catch {
        if (pipe.closed || signal?.aborted) break;
      } finally {
        if (session && !pipe.closed) await pipe.send("Target.detachFromTarget", { sessionId: session }).catch(() => {});
      }
      await sleep(800);
    }
    if (signal?.aborted) throw new Error("Logicc sign-in cancelled.");
    if (pipe.closed) throw new Error("Private browser was closed before sign-in completed.");
    throw new Error("Logicc sign-in timed out; try again or use the manual method.");
  } finally {
    signal?.removeEventListener("abort", abort);
    if (child && child.exitCode === null && child.signalCode === null) {
      await pipe?.send("Browser.close").catch(() => {});
      if (child.exitCode === null && child.signalCode === null) abort();
      for (let i = 0; i < 20 && child.exitCode === null && child.signalCode === null; i++) await sleep(100);
      if (child.exitCode === null && child.signalCode === null) {
        try { child.kill("SIGKILL"); } catch {}
      }
    }
    pipe?.fail();
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch {}
  }
}
