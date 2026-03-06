import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, mkdir, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Scheduler } from "../src/scheduler.js";
import type { CronConfig } from "../src/types.js";
import cron from "node-cron";

vi.mock("node-cron");

function makeBridge(overrides: Record<string, any> = {}) {
    return {
        busy: false,
        command: vi.fn().mockResolvedValue(undefined),
        sendMessage: vi.fn().mockResolvedValue("agent response"),
        ...overrides,
    } as any;
}

describe("Scheduler", () => {
    let cronDir: string;
    let scheduledCallbacks: Map<string, () => void>;
    let mockTasks: Map<string, { stop: ReturnType<typeof vi.fn> }>;

    beforeEach(async () => {
        vi.clearAllMocks();
        cronDir = await mkdtemp(join(tmpdir(), "cron-test-"));
        scheduledCallbacks = new Map();
        mockTasks = new Map();

        vi.mocked(cron.validate).mockReturnValue(true);
        vi.mocked(cron.schedule).mockImplementation((schedule, cb) => {
            const key = `${schedule}-${Math.random()}`;
            scheduledCallbacks.set(key, cb as () => void);
            const task = { stop: vi.fn() };
            mockTasks.set(key, task);
            return task as any;
        });
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        await rm(cronDir, { recursive: true, force: true });
    });

    async function writeJob(name: string, content: string) {
        const filePath = join(cronDir, `${name}.md`);
        // Ensure parent directories exist for nested paths like "morning/checklist"
        const dir = filePath.substring(0, filePath.lastIndexOf("/"));
        if (dir !== cronDir) {
            await mkdir(dir, { recursive: true });
        }
        await writeFile(filePath, content);
    }

    function getLastScheduledCallback() {
        const entries = [...scheduledCallbacks.entries()];
        return entries[entries.length - 1]?.[1];
    }

    it("loads all job files on start", async () => {
        await writeJob("morning", `---
schedule: "0 7 * * *"
steps:
  - compact
---`);
        await writeJob("evening", `---
schedule: "0 17 * * *"
steps:
  - compact
---`);

        const bridge = makeBridge();
        const config: CronConfig = { dir: cronDir };
        const scheduler = new Scheduler(config, bridge);
        await scheduler.start();

        expect(cron.schedule).toHaveBeenCalledTimes(2);
        expect(scheduler.getJobs().size).toBe(2);

        scheduler.stop();
    });

    it("skips disabled jobs", async () => {
        await writeJob("disabled", `---
schedule: "0 7 * * *"
enabled: false
steps:
  - compact
---`);

        const bridge = makeBridge();
        const scheduler = new Scheduler({ dir: cronDir }, bridge);
        await scheduler.start();

        expect(scheduler.getJobs().size).toBe(0);

        scheduler.stop();
    });

    it("skips invalid job files gracefully", async () => {
        await writeJob("bad", "not a valid job file at all");
        await writeJob("good", `---
schedule: "0 7 * * *"
steps:
  - compact
---`);

        const bridge = makeBridge();
        const scheduler = new Scheduler({ dir: cronDir }, bridge);
        await scheduler.start();

        expect(scheduler.getJobs().size).toBe(1);

        scheduler.stop();
    });

    it("ignores non-.md files", async () => {
        await writeFile(join(cronDir, "notes.txt"), "not a job");
        await writeJob("real", `---
schedule: "0 7 * * *"
steps:
  - compact
---`);

        const bridge = makeBridge();
        const scheduler = new Scheduler({ dir: cronDir }, bridge);
        await scheduler.start();

        expect(scheduler.getJobs().size).toBe(1);

        scheduler.stop();
    });

    it("executes new-session step", async () => {
        await writeJob("test", `---
schedule: "0 7 * * *"
steps:
  - new-session
---`);

        const bridge = makeBridge();
        const scheduler = new Scheduler({ dir: cronDir }, bridge);
        await scheduler.start();

        const cb = getLastScheduledCallback()!;
        await cb();

        expect(bridge.command).toHaveBeenCalledWith("new_session");

        scheduler.stop();
    });

    it("executes compact step", async () => {
        await writeJob("test", `---
schedule: "0 7 * * *"
steps:
  - compact
---`);

        const bridge = makeBridge();
        const scheduler = new Scheduler({ dir: cronDir }, bridge);
        await scheduler.start();

        await getLastScheduledCallback()!();

        expect(bridge.command).toHaveBeenCalledWith("compact");

        scheduler.stop();
    });

    it("executes model step with fuzzy match", async () => {
        await writeJob("test", `---
schedule: "0 7 * * *"
steps:
  - model: haiku
---`);

        const bridge = makeBridge({
            command: vi.fn().mockImplementation((type: string) => {
                if (type === "get_available_models") {
                    return Promise.resolve({
                        models: [
                            { provider: "anthropic", id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
                            { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
                        ],
                    });
                }
                return Promise.resolve(undefined);
            }),
        });

        const scheduler = new Scheduler({ dir: cronDir }, bridge);
        await scheduler.start();

        await getLastScheduledCallback()!();

        expect(bridge.command).toHaveBeenCalledWith("set_model", {
            provider: "anthropic",
            modelId: "claude-haiku-4-5",
        });

        scheduler.stop();
    });

    it("fails model step when no match found", async () => {
        await writeJob("test", `---
schedule: "0 7 * * *"
steps:
  - model: nonexistent
  - compact
---`);

        const bridge = makeBridge({
            command: vi.fn().mockImplementation((type: string) => {
                if (type === "get_available_models") {
                    return Promise.resolve({ models: [] });
                }
                return Promise.resolve(undefined);
            }),
        });

        const scheduler = new Scheduler({ dir: cronDir }, bridge);
        await scheduler.start();

        // Should not throw (caught internally), but compact should NOT run
        await getLastScheduledCallback()!();

        // Only get_available_models was called, not compact
        expect(bridge.command).toHaveBeenCalledTimes(1);
        expect(bridge.command).toHaveBeenCalledWith("get_available_models");

        scheduler.stop();
    });

    it("executes prompt step and emits response", async () => {
        await writeJob("test", `---
schedule: "0 7 * * *"
steps:
  - prompt
---

Do the thing.`);

        const bridge = makeBridge();
        const scheduler = new Scheduler({ dir: cronDir }, bridge);
        const responses: any[] = [];
        scheduler.on("response", (r: any) => responses.push(r));
        await scheduler.start();

        await getLastScheduledCallback()!();

        expect(bridge.sendMessage).toHaveBeenCalledWith("[CRON:test] Do the thing.", expect.objectContaining({
            onText: expect.any(Function),
            onToolStart: expect.any(Function),
        }));
        expect(responses).toHaveLength(1);
        expect(responses[0].response).toBe("agent response");
        expect(responses[0].job.name).toBe("test");

        scheduler.stop();
    });

    it("does not emit response for empty agent reply", async () => {
        await writeJob("test", `---
schedule: "0 7 * * *"
steps:
  - prompt
---

Do the thing.`);

        const bridge = makeBridge({ sendMessage: vi.fn().mockResolvedValue("   ") });
        const scheduler = new Scheduler({ dir: cronDir }, bridge);
        const responses: any[] = [];
        scheduler.on("response", (r: any) => responses.push(r));
        await scheduler.start();

        await getLastScheduledCallback()!();

        expect(responses).toHaveLength(0);

        scheduler.stop();
    });

    it("emits text and tool-start events during prompt step", async () => {
        await writeJob("test", `---
schedule: "0 7 * * *"
steps:
  - prompt
---

Do the thing.`);

        // Capture the onText/onToolStart callbacks when sendMessage is called
        let capturedOnText: ((text: string) => void) | undefined;
        let capturedOnToolStart: ((info: any) => void) | undefined;

        const bridge = makeBridge({
            sendMessage: vi.fn().mockImplementation((_msg: string, opts?: any) => {
                capturedOnText = opts?.onText;
                capturedOnToolStart = opts?.onToolStart;
                // Simulate bridge calling the callbacks during execution
                if (capturedOnText) capturedOnText("Here's the morning hello");
                if (capturedOnToolStart) capturedOnToolStart({ toolName: "write", args: { path: "/tmp/test.md" } });
                if (capturedOnText) capturedOnText("Final response");
                return Promise.resolve("Final response");
            }),
        });

        const scheduler = new Scheduler({ dir: cronDir }, bridge);
        const textEvents: any[] = [];
        const toolEvents: any[] = [];
        scheduler.on("text", (e: any) => textEvents.push(e));
        scheduler.on("tool-start", (e: any) => toolEvents.push(e));
        await scheduler.start();

        await getLastScheduledCallback()!();

        expect(textEvents).toHaveLength(2);
        expect(textEvents[0].text).toBe("Here's the morning hello");
        expect(textEvents[1].text).toBe("Final response");
        expect(toolEvents).toHaveLength(1);
        expect(toolEvents[0].info.toolName).toBe("write");

        scheduler.stop();
    });

    it("emits aborted event when prompt is interrupted by user", async () => {
        await writeJob("test", `---
schedule: "0 7 * * *"
steps:
  - prompt
---

Do the thing.`);

        const bridge = makeBridge({
            sendMessage: vi.fn().mockRejectedValue(new Error("Interrupted by bot!abort")),
        });
        const scheduler = new Scheduler({ dir: cronDir }, bridge);
        const aborted: any[] = [];
        const responses: any[] = [];
        scheduler.on("aborted", (e: any) => aborted.push(e));
        scheduler.on("response", (r: any) => responses.push(r));
        await scheduler.start();

        await getLastScheduledCallback()!();

        expect(aborted).toHaveLength(1);
        expect(aborted[0].job.name).toBe("test");
        expect(responses).toHaveLength(0);

        scheduler.stop();
    });

    it("emits aborted event for Cancelled errors too", async () => {
        await writeJob("test", `---
schedule: "0 7 * * *"
steps:
  - prompt
---

Do the thing.`);

        const bridge = makeBridge({
            sendMessage: vi.fn().mockRejectedValue(new Error("Cancelled")),
        });
        const scheduler = new Scheduler({ dir: cronDir }, bridge);
        const aborted: any[] = [];
        scheduler.on("aborted", (e: any) => aborted.push(e));
        await scheduler.start();

        await getLastScheduledCallback()!();

        expect(aborted).toHaveLength(1);

        scheduler.stop();
    });

    it("executes reload step", async () => {
        await writeJob("test", `---
schedule: "0 7 * * *"
steps:
  - reload
---`);

        const bridge = makeBridge();
        const scheduler = new Scheduler({ dir: cronDir }, bridge);
        await scheduler.start();

        await getLastScheduledCallback()!();

        expect(bridge.command).toHaveBeenCalledWith("prompt", { message: "/reload-runtime" });

        scheduler.stop();
    });

    it("executes steps in order", async () => {
        await writeJob("test", `---
schedule: "0 7 * * *"
steps:
  - new-session
  - compact
  - reload
---`);

        const callOrder: Array<{ type: string; args?: any }> = [];
        const bridge = makeBridge({
            command: vi.fn().mockImplementation((type: string, args?: any) => {
                callOrder.push({ type, args });
                return Promise.resolve(undefined);
            }),
        });

        const scheduler = new Scheduler({ dir: cronDir }, bridge);
        await scheduler.start();

        await getLastScheduledCallback()!();

        expect(callOrder).toEqual([
            { type: "new_session", args: undefined },
            { type: "compact", args: undefined },
            { type: "prompt", args: { message: "/reload-runtime" } },
        ]);

        scheduler.stop();
    });

    it("aborts remaining steps on failure", async () => {
        await writeJob("test", `---
schedule: "0 7 * * *"
steps:
  - new-session
  - compact
---`);

        const bridge = makeBridge({
            command: vi.fn().mockRejectedValueOnce(new Error("boom")),
        });

        const scheduler = new Scheduler({ dir: cronDir }, bridge);
        await scheduler.start();

        // Should not throw
        await getLastScheduledCallback()!();

        // Only the first command was attempted
        expect(bridge.command).toHaveBeenCalledTimes(1);

        scheduler.stop();
    });

    it("skips job when bridge is busy", async () => {
        await writeJob("test", `---
schedule: "0 7 * * *"
steps:
  - compact
---`);

        const bridge = makeBridge({ busy: true });
        const scheduler = new Scheduler({ dir: cronDir }, bridge);
        await scheduler.start();

        await getLastScheduledCallback()!();

        expect(bridge.command).not.toHaveBeenCalled();

        scheduler.stop();
    });

    it("stops all cron tasks on stop()", async () => {
        await writeJob("a", `---
schedule: "0 7 * * *"
steps:
  - compact
---`);
        await writeJob("b", `---
schedule: "0 17 * * *"
steps:
  - compact
---`);

        const bridge = makeBridge();
        const scheduler = new Scheduler({ dir: cronDir }, bridge);
        await scheduler.start();

        expect(scheduler.getJobs().size).toBe(2);

        scheduler.stop();

        expect(scheduler.getJobs().size).toBe(0);
        for (const task of mockTasks.values()) {
            expect(task.stop).toHaveBeenCalled();
        }
    });

    it("skips second job when first is still executing", async () => {
        await writeJob("slow", `---
schedule: "0 7 * * *"
steps:
  - compact
---`);

        let resolveCompact: () => void;
        const compactPromise = new Promise<void>((r) => { resolveCompact = r; });

        const bridge = makeBridge({
            command: vi.fn().mockImplementation((type: string) => {
                if (type === "compact") return compactPromise;
                return Promise.resolve(undefined);
            }),
        });

        const scheduler = new Scheduler({ dir: cronDir }, bridge);
        await scheduler.start();

        // Start the slow job (blocks on compact)
        const slowCb = getLastScheduledCallback()!;
        const slowPromise = slowCb();

        // Now add a second job while the first is executing
        await writeJob("fast", `---
schedule: "0 7 * * *"
steps:
  - new-session
---`);
        await new Promise((r) => setTimeout(r, 500)); // wait for hot reload

        // Fire the second job — should be skipped due to mutex
        const callbacks = [...scheduledCallbacks.values()];
        const fastCb = callbacks[callbacks.length - 1];
        const fastPromise = fastCb();

        // Let the first job finish
        resolveCompact!();
        await slowPromise;
        await fastPromise;

        const calls = (bridge.command as any).mock.calls.map((c: any) => c[0]);
        expect(calls).toContain("compact");
        expect(calls).not.toContain("new_session");

        scheduler.stop();
    });

    it("stop() waits for in-flight job execution", async () => {
        await writeJob("test", `---
schedule: "0 7 * * *"
steps:
  - compact
---`);

        let resolveCompact: () => void;
        const compactPromise = new Promise<void>((r) => { resolveCompact = r; });

        const callOrder: string[] = [];
        const bridge = makeBridge({
            command: vi.fn().mockImplementation((type: string) => {
                callOrder.push(`command:${type}`);
                if (type === "compact") return compactPromise;
                return Promise.resolve(undefined);
            }),
        });

        const scheduler = new Scheduler({ dir: cronDir }, bridge);
        await scheduler.start();

        // Start a job
        const jobPromise = getLastScheduledCallback()!();

        // Immediately stop — should wait for job
        const stopPromise = scheduler.stop();

        // Job is still running (compact hasn't resolved)
        expect(callOrder).toContain("command:compact");

        // Resolve compact so the job can finish
        resolveCompact!();
        await jobPromise;
        await stopPromise;

        // Stop completed after the job finished
        expect(scheduler.getJobs().size).toBe(0);
    });

    it("handles missing cron directory gracefully", async () => {
        const bridge = makeBridge();
        const scheduler = new Scheduler({ dir: "/nonexistent/path" }, bridge);

        // Should not throw
        await scheduler.start();
        expect(scheduler.getJobs().size).toBe(0);

        scheduler.stop();
    });

    describe("user interaction grace period", () => {
        it("skips job when user interacted within grace period", async () => {
            await writeJob("test", `---
schedule: "0 7 * * *"
steps:
  - compact
---`);

            const bridge = makeBridge();
            // User interacted 1 second ago
            const getUserInteractionTime = vi.fn().mockReturnValue(Date.now() - 1000);
            const scheduler = new Scheduler({ dir: cronDir }, bridge, getUserInteractionTime);
            await scheduler.start();

            await getLastScheduledCallback()!();

            expect(bridge.command).not.toHaveBeenCalled();

            scheduler.stop();
        });

        it("runs job when grace period has elapsed", async () => {
            await writeJob("test", `---
schedule: "0 7 * * *"
steps:
  - compact
---`);

            const bridge = makeBridge();
            // User interacted 10 seconds ago (default grace is 5s)
            const getUserInteractionTime = vi.fn().mockReturnValue(Date.now() - 10000);
            const scheduler = new Scheduler({ dir: cronDir }, bridge, getUserInteractionTime);
            await scheduler.start();

            await getLastScheduledCallback()!();

            expect(bridge.command).toHaveBeenCalledWith("compact");

            scheduler.stop();
        });

        it("respects per-job gracePeriodMs override", async () => {
            await writeJob("test", `---
schedule: "0 7 * * *"
gracePeriodMs: 2000
steps:
  - compact
---`);

            const bridge = makeBridge();
            // User interacted 3 seconds ago — outside per-job 2s grace, within default 5s
            const getUserInteractionTime = vi.fn().mockReturnValue(Date.now() - 3000);
            const scheduler = new Scheduler({ dir: cronDir }, bridge, getUserInteractionTime);
            await scheduler.start();

            await getLastScheduledCallback()!();

            expect(bridge.command).toHaveBeenCalledWith("compact");

            scheduler.stop();
        });

        it("respects global gracePeriodMs from config", async () => {
            await writeJob("test", `---
schedule: "0 7 * * *"
steps:
  - compact
---`);

            const bridge = makeBridge();
            // User interacted 8 seconds ago — outside custom global 7s grace
            const getUserInteractionTime = vi.fn().mockReturnValue(Date.now() - 8000);
            const config: CronConfig = { dir: cronDir, gracePeriodMs: 7000 };
            const scheduler = new Scheduler(config, bridge, getUserInteractionTime);
            await scheduler.start();

            await getLastScheduledCallback()!();

            expect(bridge.command).toHaveBeenCalledWith("compact");

            scheduler.stop();
        });

        it("skips job when within global gracePeriodMs", async () => {
            await writeJob("test", `---
schedule: "0 7 * * *"
steps:
  - compact
---`);

            const bridge = makeBridge();
            // User interacted 3 seconds ago — within custom global 7s grace
            const getUserInteractionTime = vi.fn().mockReturnValue(Date.now() - 3000);
            const config: CronConfig = { dir: cronDir, gracePeriodMs: 7000 };
            const scheduler = new Scheduler(config, bridge, getUserInteractionTime);
            await scheduler.start();

            await getLastScheduledCallback()!();

            expect(bridge.command).not.toHaveBeenCalled();

            scheduler.stop();
        });

        it("gracePeriodMs: 0 disables grace period for that job", async () => {
            await writeJob("test", `---
schedule: "0 7 * * *"
gracePeriodMs: 0
steps:
  - compact
---`);

            const bridge = makeBridge();
            // User interacted just now — but job has grace period of 0
            const getUserInteractionTime = vi.fn().mockReturnValue(Date.now());
            const scheduler = new Scheduler({ dir: cronDir }, bridge, getUserInteractionTime);
            await scheduler.start();

            await getLastScheduledCallback()!();

            expect(bridge.command).toHaveBeenCalledWith("compact");

            scheduler.stop();
        });

        it("runs normally when no callback is provided", async () => {
            await writeJob("test", `---
schedule: "0 7 * * *"
steps:
  - compact
---`);

            const bridge = makeBridge();
            // No getUserInteractionTime callback — grace period check skipped entirely
            const scheduler = new Scheduler({ dir: cronDir }, bridge);
            await scheduler.start();

            await getLastScheduledCallback()!();

            expect(bridge.command).toHaveBeenCalledWith("compact");

            scheduler.stop();
        });
    });

    describe("hot reload", () => {
        it("picks up new job files", async () => {
            const bridge = makeBridge();
            const scheduler = new Scheduler({ dir: cronDir }, bridge);
            await scheduler.start();

            expect(scheduler.getJobs().size).toBe(0);

            await writeJob("new-job", `---
schedule: "0 12 * * *"
steps:
  - compact
---`);

            // Wait for debounce
            await new Promise((r) => setTimeout(r, 500));

            expect(scheduler.getJobs().size).toBe(1);

            scheduler.stop();
        });

        it("removes jobs when files are deleted", async () => {
            await writeJob("to-delete", `---
schedule: "0 7 * * *"
steps:
  - compact
---`);

            const bridge = makeBridge();
            const scheduler = new Scheduler({ dir: cronDir }, bridge);
            await scheduler.start();

            expect(scheduler.getJobs().size).toBe(1);

            await unlink(join(cronDir, "to-delete.md"));

            // Wait for debounce
            await new Promise((r) => setTimeout(r, 500));

            expect(scheduler.getJobs().size).toBe(0);

            scheduler.stop();
        });

        it("reloads modified job files", async () => {
            await writeJob("mutable", `---
schedule: "0 7 * * *"
steps:
  - compact
---`);

            const bridge = makeBridge();
            const scheduler = new Scheduler({ dir: cronDir }, bridge);
            await scheduler.start();

            const jobBefore = scheduler.getJobs().get("mutable")!;
            expect(jobBefore.definition.steps).toEqual([{ type: "compact" }]);

            // Modify the file
            await writeJob("mutable", `---
schedule: "0 7 * * *"
steps:
  - new-session
  - compact
---`);

            await new Promise((r) => setTimeout(r, 500));

            const jobAfter = scheduler.getJobs().get("mutable")!;
            expect(jobAfter.definition.steps).toEqual([
                { type: "new-session" },
                { type: "compact" },
            ]);

            scheduler.stop();
        });
    });

    describe("nested directories", () => {
        it("discovers jobs in subdirectories", async () => {
            await writeJob("morning/checklist", `---
schedule: "0 7 * * *"
steps:
  - compact
---`);
            await writeJob("evening/report", `---
schedule: "0 17 * * *"
steps:
  - compact
---`);

            const bridge = makeBridge();
            const scheduler = new Scheduler({ dir: cronDir }, bridge);
            await scheduler.start();

            expect(scheduler.getJobs().size).toBe(2);
            expect(scheduler.getJobs().has("morning/checklist")).toBe(true);
            expect(scheduler.getJobs().has("evening/report")).toBe(true);

            scheduler.stop();
        });

        it("uses path-based job names for nested files", async () => {
            await writeJob("daily/maintenance/cleanup", `---
schedule: "0 3 * * *"
steps:
  - compact
---`);

            const bridge = makeBridge();
            const scheduler = new Scheduler({ dir: cronDir }, bridge);
            await scheduler.start();

            const jobs = scheduler.getJobs();
            expect(jobs.has("daily/maintenance/cleanup")).toBe(true);
            expect(jobs.get("daily/maintenance/cleanup")!.definition.name).toBe("daily/maintenance/cleanup");

            scheduler.stop();
        });

        it("mixes flat and nested jobs", async () => {
            await writeJob("root-job", `---
schedule: "0 7 * * *"
steps:
  - compact
---`);
            await writeJob("morning/checklist", `---
schedule: "0 8 * * *"
steps:
  - compact
---`);

            const bridge = makeBridge();
            const scheduler = new Scheduler({ dir: cronDir }, bridge);
            await scheduler.start();

            const jobs = scheduler.getJobs();
            expect(jobs.size).toBe(2);
            expect(jobs.has("root-job")).toBe(true);
            expect(jobs.has("morning/checklist")).toBe(true);

            scheduler.stop();
        });

        it("executes nested job and includes path in CRON prefix", async () => {
            await writeJob("morning/greet", `---
schedule: "0 7 * * *"
steps:
  - prompt
---

Good morning!`);

            const bridge = makeBridge();
            const scheduler = new Scheduler({ dir: cronDir }, bridge);
            await scheduler.start();

            await getLastScheduledCallback()!();

            expect(bridge.sendMessage).toHaveBeenCalledWith("[CRON:morning/greet] Good morning!", expect.objectContaining({
                onText: expect.any(Function),
                onToolStart: expect.any(Function),
            }));

            scheduler.stop();
        });

        it("ignores non-.md files in subdirectories", async () => {
            await mkdir(join(cronDir, "subdir"), { recursive: true });
            await writeFile(join(cronDir, "subdir", "notes.txt"), "not a job");
            await writeJob("subdir/real", `---
schedule: "0 7 * * *"
steps:
  - compact
---`);

            const bridge = makeBridge();
            const scheduler = new Scheduler({ dir: cronDir }, bridge);
            await scheduler.start();

            expect(scheduler.getJobs().size).toBe(1);
            expect(scheduler.getJobs().has("subdir/real")).toBe(true);

            scheduler.stop();
        });

        it("hot-reloads new jobs in subdirectories", async () => {
            const bridge = makeBridge();
            const scheduler = new Scheduler({ dir: cronDir }, bridge);
            await scheduler.start();

            expect(scheduler.getJobs().size).toBe(0);

            await writeJob("morning/new-task", `---
schedule: "0 9 * * *"
steps:
  - compact
---`);

            // Wait for debounce
            await new Promise((r) => setTimeout(r, 500));

            expect(scheduler.getJobs().size).toBe(1);
            expect(scheduler.getJobs().has("morning/new-task")).toBe(true);

            scheduler.stop();
        });

        it("hot-reloads deleted jobs in subdirectories", async () => {
            await writeJob("morning/to-delete", `---
schedule: "0 7 * * *"
steps:
  - compact
---`);

            const bridge = makeBridge();
            const scheduler = new Scheduler({ dir: cronDir }, bridge);
            await scheduler.start();

            expect(scheduler.getJobs().size).toBe(1);

            await unlink(join(cronDir, "morning", "to-delete.md"));

            // Wait for debounce
            await new Promise((r) => setTimeout(r, 500));

            expect(scheduler.getJobs().size).toBe(0);

            scheduler.stop();
        });
    });

    describe("session-aware execution", () => {
        function makeSessionManager(bridges: Record<string, ReturnType<typeof makeBridge>>) {
            const defaultSession = Object.keys(bridges)[0] ?? "main";
            return {
                getDefaultSessionName: vi.fn().mockReturnValue(defaultSession),
                getOrStartSession: vi.fn().mockImplementation((name: string) => {
                    const bridge = bridges[name];
                    if (!bridge) return Promise.reject(new Error(`Unknown session: ${name}`));
                    return Promise.resolve(bridge);
                }),
            } as any;
        }

        it("routes job to specified session", async () => {
            await writeJob("work-task", `---
schedule: "0 7 * * *"
session: work
steps:
  - compact
---`);

            const mainBridge = makeBridge();
            const workBridge = makeBridge();
            const sm = makeSessionManager({ main: mainBridge, work: workBridge });

            const scheduler = new Scheduler({ dir: cronDir }, mainBridge);
            scheduler.setSessionManager(sm);
            await scheduler.start();

            await getLastScheduledCallback()!();

            // Should have used the work session bridge, not main
            expect(workBridge.command).toHaveBeenCalledWith("compact");
            expect(mainBridge.command).not.toHaveBeenCalled();
            expect(sm.getOrStartSession).toHaveBeenCalledWith("work");

            scheduler.stop();
        });

        it("routes job to default session when no session specified", async () => {
            await writeJob("default-task", `---
schedule: "0 7 * * *"
steps:
  - compact
---`);

            const mainBridge = makeBridge();
            const sm = makeSessionManager({ main: mainBridge });

            const scheduler = new Scheduler({ dir: cronDir }, mainBridge);
            scheduler.setSessionManager(sm);
            await scheduler.start();

            await getLastScheduledCallback()!();

            expect(mainBridge.command).toHaveBeenCalledWith("compact");
            expect(sm.getOrStartSession).toHaveBeenCalledWith("main");

            scheduler.stop();
        });

        it("handles unknown session gracefully and emits job-error", async () => {
            await writeJob("bad-session", `---
schedule: "0 7 * * *"
session: nonexistent
steps:
  - compact
---`);

            const mainBridge = makeBridge();
            const sm = makeSessionManager({ main: mainBridge });

            const scheduler = new Scheduler({ dir: cronDir }, mainBridge);
            scheduler.setSessionManager(sm);

            const errors: any[] = [];
            scheduler.on("job-error", (err) => errors.push(err));

            await scheduler.start();

            // Should not throw
            await getLastScheduledCallback()!();

            // No commands should have been sent
            expect(mainBridge.command).not.toHaveBeenCalled();

            // Should have emitted a job-error event
            expect(errors).toHaveLength(1);
            expect(errors[0].job).toBe("bad-session");
            expect(errors[0].session).toBe("nonexistent");

            scheduler.stop();
        });

        it("sends prompt to session-specific bridge", async () => {
            await writeJob("work-prompt", `---
schedule: "0 7 * * *"
session: work
steps:
  - prompt
---

Do work stuff.`);

            const mainBridge = makeBridge();
            const workBridge = makeBridge();
            const sm = makeSessionManager({ main: mainBridge, work: workBridge });

            const scheduler = new Scheduler({ dir: cronDir }, mainBridge);
            scheduler.setSessionManager(sm);
            await scheduler.start();

            await getLastScheduledCallback()!();

            expect(workBridge.sendMessage).toHaveBeenCalledWith("[CRON:work-prompt] Do work stuff.", expect.objectContaining({
                onText: expect.any(Function),
                onToolStart: expect.any(Function),
            }));
            expect(mainBridge.sendMessage).not.toHaveBeenCalled();

            scheduler.stop();
        });

        it("falls back to direct bridge when no session manager", async () => {
            await writeJob("no-sm", `---
schedule: "0 7 * * *"
session: work
steps:
  - compact
---`);

            const bridge = makeBridge();
            // No setSessionManager call — uses direct bridge
            const scheduler = new Scheduler({ dir: cronDir }, bridge);
            await scheduler.start();

            await getLastScheduledCallback()!();

            // Should use the direct bridge regardless of session field
            expect(bridge.command).toHaveBeenCalledWith("compact");

            scheduler.stop();
        });

        it("skips session job when that session's bridge is busy", async () => {
            await writeJob("busy-session", `---
schedule: "0 7 * * *"
session: work
steps:
  - compact
---`);

            const mainBridge = makeBridge();
            const workBridge = makeBridge({ busy: true });
            const sm = makeSessionManager({ main: mainBridge, work: workBridge });

            const scheduler = new Scheduler({ dir: cronDir }, mainBridge);
            scheduler.setSessionManager(sm);
            await scheduler.start();

            await getLastScheduledCallback()!();

            expect(workBridge.command).not.toHaveBeenCalled();

            scheduler.stop();
        });
    });
});
