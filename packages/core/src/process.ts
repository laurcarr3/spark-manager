import { spawn } from "node:child_process";

export interface ProcessExit {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  spawnError: string | null;
}

export interface LaunchedProcess {
  readonly pid: number | null;
  /** Resolves when the process exits or fails to start; never rejects. */
  readonly exited: Promise<ProcessExit>;
  /** Sends SIGTERM to the process group, then SIGKILL after `graceMs`. */
  terminate(graceMs: number): Promise<ProcessExit>;
}

export function launchProcess(options: {
  command: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  onLine: (stream: "stdout" | "stderr", line: string) => void;
}): LaunchedProcess {
  const [executable, ...args] = options.command;
  if (!executable) {
    const exit = { exitCode: null, signal: null, spawnError: "Command must not be empty." };
    return { pid: null, exited: Promise.resolve(exit), terminate: async () => exit };
  }
  // Detached so the whole group, including helpers the recipe starts, can be signalled.
  const child = spawn(executable, args, {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = new LineSplitter((line) => options.onLine("stdout", line));
  const stderr = new LineSplitter((line) => options.onLine("stderr", line));
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => stdout.push(chunk));
  child.stderr.on("data", (chunk: string) => stderr.push(chunk));

  const exited = new Promise<ProcessExit>((resolveExit) => {
    let settled = false;
    const settle = (exit: ProcessExit): void => {
      if (!settled) {
        settled = true;
        stdout.flush();
        stderr.flush();
        resolveExit(exit);
      }
    };
    child.once("error", (error) => settle({ exitCode: null, signal: null, spawnError: error.message }));
    child.once("close", (exitCode, signal) => settle({ exitCode, signal, spawnError: null }));
    // "close" waits for every holder of the pipes; a background helper the
    // recipe forgot to reap must not keep the operation open indefinitely.
    child.once("exit", (exitCode, signal) => {
      const timer = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        settle({ exitCode, signal, spawnError: null });
      }, 2000);
      timer.unref();
    });
  });

  const signalGroup = (signal: NodeJS.Signals): void => {
    if (child.pid === undefined) return;
    try {
      process.kill(process.platform === "win32" ? child.pid : -child.pid, signal);
    } catch {
      // The group already exited.
    }
  };

  return {
    pid: child.pid ?? null,
    exited,
    async terminate(graceMs: number): Promise<ProcessExit> {
      signalGroup("SIGTERM");
      const timer = setTimeout(() => signalGroup("SIGKILL"), graceMs);
      timer.unref();
      try {
        return await exited;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** Splits streamed output into lines, treating carriage returns as line breaks. */
export class LineSplitter {
  #pending = "";
  constructor(private readonly onLine: (line: string) => void) {}

  push(chunk: string): void {
    const parts = (this.#pending + chunk).split(/\r\n|\n|\r/);
    this.#pending = parts.pop() ?? "";
    if (this.#pending.length > 64 * 1024) {
      this.onLine(this.#pending);
      this.#pending = "";
    }
    for (const part of parts) {
      if (part.trim()) this.onLine(part);
    }
  }

  flush(): void {
    if (this.#pending.trim()) this.onLine(this.#pending);
    this.#pending = "";
  }
}
