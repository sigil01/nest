import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { watch, type FSWatcher } from "node:fs";
import { EventEmitter } from "node:events";
import cron from "node-cron";
import { parseJobFile } from "./job.js";
import type { Bridge } from "./bridge.js";
import type { SessionManager } from "./session-manager.js";
import type { CronConfig, JobDefinition, Step } from "./types.js";
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

    /**
     * Set a SessionManager for resolving per-job session bridges.
     * When set, jobs with a `session` field will use the named session's bridge.
     * Jobs without a `session` field use the default session.
     */
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
        for (const [name, active] of this.jobs) {
            active.task.stop();
            logger.info("Stopped cron job", { name });
        }
        this.jobs.clear();
        for (const timer of this.debounceTimers.values()) {
            clearTimeout(timer);
        }
        this.debounceTimers.clear();

        // Wait for any in-flight job execution to finish
        if (this.activeExecution) {
            await this.activeExecution;
        }
    }

    getJobs(): Map<string, ActiveJob> {
        return new Map(this.jobs);
    }

    private async loadAllJobs(): Promise<void> {
        let entries: string[];
        try {
            entries = await readdir(this.config.dir, { recursive: true });
        } catch (err) {
            logger.error("Failed to read cron directory", { dir: this.config.dir, error: String(err) });
            return;
        }

        const mdFiles = entries.filter((f) => f.endsWith(".md"));
        for (const file of mdFiles) {
            await this.loadJob(join(this.config.dir, file));
        }
    }

    private async loadJob(filePath: string): Promise<void> {
        try {
            const definition = await parseJobFile(filePath, this.config.dir);

            // Remove existing job with same name if reloading
            const existing = this.jobs.get(definition.name);
            if (existing) {
                existing.task.stop();
                logger.info("Reloading cron job", { name: definition.name });
            }

            if (!definition.enabled) {
                logger.info("Skipping disabled cron job", { name: definition.name });
                if (existing) this.jobs.delete(definition.name);
                return;
            }

            const task = cron.schedule(definition.schedule, async () => {
                try {
                    await this.executeJob(definition);
                } catch (err) {
                    logger.error("Job execution failed", { name: definition.name, error: String(err) });
                }
            });

            this.jobs.set(definition.name, { definition, task });
            logger.info("Loaded cron job", { name: definition.name, schedule: definition.schedule });
        } catch (err) {
            logger.error("Failed to load job file", { file: filePath, error: String(err) });
        }
    }

    private removeJob(name: string): void {
        const existing = this.jobs.get(name);
        if (existing) {
            existing.task.stop();
            this.jobs.delete(name);
            logger.info("Removed cron job", { name });
        }
    }

    /**
     * Resolve the Bridge for a given job.
     * Uses SessionManager if available, falling back to the direct bridge.
     */
    private resolveJobBridge(job: JobDefinition): Bridge | Promise<Bridge> {
        if (this.sessionManager) {
            const sessionName = job.session ?? this.sessionManager.getDefaultSessionName();
            return this.sessionManager.getOrStartSession(sessionName);
        }
        return this.bridge;
    }

    private async executeJob(job: JobDefinition): Promise<void> {
        if (this.getUserInteractionTime) {
            const elapsed = Date.now() - this.getUserInteractionTime();
            const grace = job.gracePeriodMs ?? this.config.gracePeriodMs ?? 5000;
            if (grace > 0 && elapsed < grace) {
                logger.info("Skipping cron job, user interaction grace period", {
                    name: job.name,
                    elapsedMs: elapsed,
                    gracePeriodMs: grace,
                });
                return;
            }
        }

        // Lock mutex BEFORE any async work to prevent race condition
        if (this.executing) {
            logger.info("Skipping cron job, busy", { name: job.name });
            return;
        }
        this.executing = true;

        try {
            // Resolve the bridge for this job's session.
            let bridge: Bridge;
            try {
                const result = this.resolveJobBridge(job);
                bridge = result instanceof Promise ? await result : result;
            } catch (err) {
                logger.error("Failed to resolve session for cron job", {
                    name: job.name,
                    session: job.session,
                    error: String(err),
                });
                this.emit("job-error", { job: job.name, session: job.session, error: String(err) });
                return;
            }

            if (bridge.busy) {
                logger.info("Skipping cron job, bridge busy", { name: job.name });
                return;
            }

            const sessionName = job.session ?? this.sessionManager?.getDefaultSessionName() ?? "main";
            this.emit("job-start", { job: job.name, session: sessionName });
            const execution = this.runSteps(job, bridge);
            this.activeExecution = execution;
            try {
                await execution;
            } finally {
                this.emit("job-end", { job: job.name, session: sessionName });
            }
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
                const message = String(err instanceof Error ? err.message : err);
                if (message.includes("Interrupted") || message.includes("Cancelled")) {
                    logger.info("Cron job interrupted by user", { name: job.name, step: step.type });
                    this.emit("aborted", { job });
                    return;
                }
                logger.error("Step failed, aborting job", {
                    name: job.name,
                    step: step.type,
                    error: message,
                });
                return;
            }
        }

        logger.info("Cron job complete", { name: job.name });
    }

    private async executeStep(step: Step, job: JobDefinition, bridge: Bridge): Promise<void> {
        switch (step.type) {
            case "new-session":
                await bridge.command("new_session");
                logger.info("Step: new-session", { job: job.name });
                break;

            case "compact":
                await bridge.command("compact");
                logger.info("Step: compact", { job: job.name });
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
                if (!match) {
                    throw new Error(`No model matching '${step.model}'`);
                }
                await bridge.command("set_model", { provider: match.provider, modelId: match.id });
                logger.info("Step: model", { job: job.name, model: `${match.provider}/${match.id}` });
                break;
            }

            case "prompt": {
                const message = `[CRON:${job.name}] ${job.body}`;
                const response = await bridge.sendMessage(message, {
                    onText: (text) => {
                        if (text.trim()) {
                            this.emit("text", { job, text });
                        }
                    },
                    onToolStart: (info) => {
                        this.emit("tool-start", { job, info });
                    },
                });
                if (response && response.trim()) {
                    this.emit("response", { job, response });
                }
                logger.info("Step: prompt", { job: job.name, responseLength: response?.length ?? 0 });
                break;
            }

            case "reload":
                await bridge.command("prompt", { message: "/reload-runtime" });
                logger.info("Step: reload", { job: job.name });
                break;
        }
    }

    // --- Hot reload ---

    private startWatcher(): void {
        try {
            this.watcher = watch(this.config.dir, { recursive: true }, (eventType, filename) => {
                if (!filename || !filename.endsWith(".md")) return;
                this.debouncedReload(filename);
            });
            logger.info("Watching cron directory", { dir: this.config.dir });
        } catch (err) {
            logger.error("Failed to start directory watcher", { dir: this.config.dir, error: String(err) });
        }
    }

    private stopWatcher(): void {
        if (this.watcher) {
            this.watcher.close();
            this.watcher = null;
        }
    }

    private debouncedReload(filename: string): void {
        const existing = this.debounceTimers.get(filename);
        if (existing) clearTimeout(existing);

        this.debounceTimers.set(
            filename,
            setTimeout(async () => {
                this.debounceTimers.delete(filename);
                const filePath = join(this.config.dir, filename);
                const name = filename.replace(/\.md$/, "").replace(/\\/g, "/");

                // Check if file still exists (might have been deleted)
                try {
                    await stat(filePath);
                    await this.loadJob(filePath);
                } catch {
                    this.removeJob(name);
                }
            }, 300),
        );
    }
}
