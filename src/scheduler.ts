import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { watch, type FSWatcher } from "node:fs";
import { EventEmitter } from "node:events";
import cron from "node-cron";
import { parseJobFile } from "./job.js";
import type { Bridge } from "./bridge.js";
import type { SessionManager } from "./session-manager.js";
import type { CronConfig, JobDefinition, Step, ToolCallInfo } from "./types.js";
import * as logger from "./logger.js";

interface ActiveJob {
    definition: JobDefinition;
    task: cron.ScheduledTask;
}

export class Scheduler extends EventEmitter {
    private config: CronConfig;
    private bridge: Bridge;
    private sessionManager: SessionManager | null = null;
    private getUserInteractionTime: (() => number) | undefined;
    private jobs = new Map<string, ActiveJob>();
    private watcher: FSWatcher | null = null;
    private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private executing = false;
    private activeExecution: Promise<void> | null = null;

    constructor(config: CronConfig, bridge: Bridge, getUserInteractionTime?: () => number) {
        super();
        this.config = config;
        this.bridge = bridge;
        this.getUserInteractionTime = getUserInteractionTime;
    }

    setSessionManager(sm: SessionManager): void {
        this.sessionManager = sm;
    }

    async start(): Promise<void> {
        await this.loadAllJobs();
        this.startWatcher();
        logger.info("Scheduler started", { dir: this.config.dir, jobs: this.jobs.size });
    }

    async stop(): Promise<void> {
        this.stopWatcher();
        for (const [, active] of this.jobs) active.task.stop();
        this.jobs.clear();
        for (const timer of this.debounceTimers.values()) clearTimeout(timer);
        this.debounceTimers.clear();
        if (this.activeExecution) await this.activeExecution;
    }

    getJobs(): Map<string, ActiveJob> {
        return new Map(this.jobs);
    }

    private async loadAllJobs(): Promise<void> {
        let entries: string[];
        try {
            entries = await readdir(this.config.dir, { recursive: true });
        } catch {
            return;
        }

        for (const file of entries.filter((f) => f.endsWith(".md"))) {
            await this.loadJob(join(this.config.dir, file));
        }
    }

    private async loadJob(filePath: string): Promise<void> {
        try {
            const definition = await parseJobFile(filePath, this.config.dir);
            const existing = this.jobs.get(definition.name);
            if (existing) existing.task.stop();

            if (!definition.enabled) {
                if (existing) this.jobs.delete(definition.name);
                return;
            }

            const task = cron.schedule(definition.schedule, async () => {
                try { await this.executeJob(definition); } catch (err) {
                    logger.error("Job failed", { name: definition.name, error: String(err) });
                }
            });

            this.jobs.set(definition.name, { definition, task });
            logger.info("Loaded cron job", { name: definition.name, schedule: definition.schedule });
        } catch (err) {
            logger.error("Failed to load job", { file: filePath, error: String(err) });
        }
    }

    private resolveJobBridge(job: JobDefinition): Bridge | Promise<Bridge> {
        if (this.sessionManager) {
            const session = job.session ?? this.sessionManager.getDefaultSessionName();
            return this.sessionManager.getOrStartSession(session);
        }
        return this.bridge;
    }

    private async executeJob(job: JobDefinition): Promise<void> {
        if (this.getUserInteractionTime) {
            const elapsed = Date.now() - this.getUserInteractionTime();
            const grace = job.gracePeriodMs ?? this.config.gracePeriodMs ?? 5000;
            if (grace > 0 && elapsed < grace) return;
        }

        if (this.executing) return;
        this.executing = true;

        try {
            let bridge: Bridge;
            try {
                const result = this.resolveJobBridge(job);
                bridge = result instanceof Promise ? await result : result;
            } catch (err) {
                logger.error("Failed to resolve session for cron", { name: job.name, error: String(err) });
                return;
            }

            if (bridge.busy) return;

            const execution = this.runSteps(job, bridge);
            this.activeExecution = execution;
            await execution;
        } finally {
            this.executing = false;
            this.activeExecution = null;
        }
    }

    private async runSteps(job: JobDefinition, bridge: Bridge): Promise<void> {
        logger.info("Executing cron job", { name: job.name, steps: job.steps.length, session: job.session });

        for (const step of job.steps) {
            try {
                await this.executeStep(step, job, bridge);
            } catch (err) {
                const msg = String(err instanceof Error ? err.message : err);
                if (msg.includes("Interrupted") || msg.includes("Cancelled")) {
                    this.emit("aborted", { job });
                    return;
                }
                logger.error("Step failed", { name: job.name, step: step.type, error: msg });
                return;
            }
        }
    }

    private async executeStep(step: Step, job: JobDefinition, bridge: Bridge): Promise<void> {
        switch (step.type) {
            case "new-session":
                await bridge.command("new_session");
                break;
            case "compact":
                await bridge.command("compact");
                break;
            case "model": {
                const result = await bridge.command("get_available_models");
                const models: any[] = result?.models ?? [];
                const query = step.model.toLowerCase();
                const match = models.find(
                    (m: any) =>
                        m.id.toLowerCase().includes(query) ||
                        m.name.toLowerCase().includes(query) ||
                        `${m.provider}/${m.id}`.toLowerCase().includes(query),
                );
                if (!match) throw new Error(`No model matching '${step.model}'`);
                await bridge.command("set_model", { provider: match.provider, modelId: match.id });
                break;
            }
            case "prompt": {
                const message = `[CRON:${job.name}] ${job.body}`;
                const response = await bridge.sendMessage(message, {
                    onText: (text) => {
                        if (text.trim()) this.emit("text", { job, text });
                    },
                    onToolStart: (info: ToolCallInfo) => {
                        this.emit("tool-start", { job, info });
                    },
                });
                if (response?.trim()) {
                    this.emit("response", { job, response });
                }
                break;
            }
            case "reload":
                await bridge.command("prompt", { message: "/reload-runtime" });
                break;
        }
    }

    // ─── Hot Reload ──────────────────────────────────────────

    private startWatcher(): void {
        try {
            this.watcher = watch(this.config.dir, { recursive: true }, (_type, filename) => {
                if (!filename?.endsWith(".md")) return;
                this.debouncedReload(filename);
            });
        } catch {}
    }

    private stopWatcher(): void {
        this.watcher?.close();
        this.watcher = null;
    }

    private debouncedReload(filename: string): void {
        const existing = this.debounceTimers.get(filename);
        if (existing) clearTimeout(existing);
        this.debounceTimers.set(filename, setTimeout(async () => {
            this.debounceTimers.delete(filename);
            const filePath = join(this.config.dir, filename);
            const name = filename.replace(/\.md$/, "").replace(/\\/g, "/");
            try {
                await stat(filePath);
                await this.loadJob(filePath);
            } catch {
                const existing = this.jobs.get(name);
                if (existing) { existing.task.stop(); this.jobs.delete(name); }
            }
        }, 300));
    }
}
