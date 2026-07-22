import { spawn } from "node:child_process";
import { z } from "zod";
import treeKill from "tree-kill";
import type { ToolDef } from "./types.js";
import { truncateOutput } from "./types.js";
import { detectShell } from "./bash.js";

const MAX_JOB_BUFFER = 400_000;

export interface BashJob {
  id: string;
  command: string;
  output: string;
  /** Where the last bash_output read ended — reads are incremental. */
  readOffset: number;
  running: boolean;
  exitCode: number | null;
  pid: number | undefined;
}

const jobs = new Map<string, BashJob>();
let counter = 0;
let cleanupInstalled = false;

export function startJob(command: string, cwd: string): BashJob {
  const shell = detectShell();
  const child = spawn(shell.path, shell.args(command), {
    cwd,
    windowsHide: true,
    shell: false,
    env: process.env,
  });
  const job: BashJob = {
    id: `job-${++counter}`,
    command,
    output: "",
    readOffset: 0,
    running: true,
    exitCode: null,
    pid: child.pid,
  };
  const append = (d: Buffer): void => {
    if (job.output.length < MAX_JOB_BUFFER) job.output += d.toString();
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  child.on("error", (err) => {
    job.running = false;
    job.output += `\n[spawn error: ${err.message}]`;
  });
  child.on("exit", (code) => {
    job.running = false;
    job.exitCode = code;
  });
  jobs.set(job.id, job);

  if (!cleanupInstalled) {
    cleanupInstalled = true;
    // Best effort: don't leave orphaned dev servers behind when aerin exits.
    process.once("exit", () => {
      for (const j of jobs.values()) {
        if (j.running && j.pid) {
          try {
            process.kill(j.pid);
          } catch {
            // already gone
          }
        }
      }
    });
  }
  return job;
}

export function getJob(id: string): BashJob | undefined {
  return jobs.get(id);
}

export function listJobs(): BashJob[] {
  return [...jobs.values()];
}

export function killJob(job: BashJob): void {
  if (job.pid) treeKill(job.pid, "SIGKILL", () => {});
}

export const bashOutputTool: ToolDef<z.ZodTypeAny> = {
  name: "bash_output",
  description:
    "Read NEW output (since the last read) from a background job started with bash background:true. " +
    "Set kill:true to terminate the job. Poll this after starting a server or long build.",
  inputSchema: z.object({
    job: z.string().describe('Job id returned by bash, e.g. "job-1"'),
    kill: z.boolean().optional().describe("Kill the job after reading its output"),
  }),
  permission: "read",
  summarize: (i) => `JobOutput(${i.job}${i.kill ? ", kill" : ""})`,
  async execute(input) {
    const job = getJob(String(input.job));
    if (!job) {
      const known = listJobs().map((j) => `${j.id} (${j.running ? "running" : "exited"})`).join(", ");
      throw new Error(`No such job: ${input.job}.${known ? ` Known jobs: ${known}` : " No jobs started yet."}`);
    }
    const fresh = job.output.slice(job.readOffset);
    job.readOffset = job.output.length;
    if (input.kill && job.running) killJob(job);
    const status = job.running ? (input.kill ? "kill requested" : "running") : `exited with code ${job.exitCode}`;
    return truncateOutput(`[${job.id}: ${status}] ${job.command}\n${fresh.trim() || "(no new output)"}`);
  },
};
