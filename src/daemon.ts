import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { Bridge } from "./bridge.js";
import type { ImageContent } from "./bridge.js";
import { commandMap } from "./commands.js";
import type { DaemonRef } from "./commands.js";
import { SessionManager } from "./session-manager.js";
import { Tracker } from "./tracker.js";
import type { Config, Listener, IncomingMessage, MessageOrigin, ToolCallInfo, ToolEndInfo, JobDefinition, OutgoingFile, Attachment, WebhookRequest, WebhookResult, ActivityEntry } from "./types.js";
import type { Scheduler } from "./scheduler.js";
import { HttpServer } from "./server.js";
import type { DashboardProvider, SessionStateInfo } from "./server.js";
import * as logger from "./logger.js";
import { getLogBuffer } from "./logger.js";
import { cleanupInbox, saveToInbox } from "./inbox.js";
import { compressImage } from "./image.js";
import { WorkspaceFiles } from "./vault/files.js";

const MAX_MESSAGE_LENGTH = 4000;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_PER_WINDOW = 10;
const COMMAND_PREFIX = "bot!";
const ACTIVITY_BUFFER_CAPACITY = 50;

function formatToolCall(info: ToolCallInfo): string {
    const { toolName, args } = info;
    switch (toolName) {
        case "read":
            return `📖 Reading \`${args?.path ?? "file"}\``;
        case "bash": {
            const cmd = String(args?.command ?? "");
            const firstLine = cmd.split("\n")[0];
            const display = firstLine.length > 80
                ? firstLine.slice(0, 80) + "…"
                : firstLine;
            return `⚡ \`${display}\``;
        }
        case "edit":
            return `✏️ Editing \`${args?.path ?? "file"}\``;
        case "write":
            return `📝 Writing \`${args?.path ?? "file"}\``;
        default:
            return `🔧 ${toolName}`;
    }
}

export class Daemon implements DaemonRef, DashboardProvider {
    private config: Config;
    private sessionManager: SessionManager;
    private listeners: Listener[] = [];
    private scheduler?: Scheduler;
    private httpServer?: HttpServer;
    private tracker: Tracker;
    private stopping = false;
    private commandRunning = false;
    private rateLimits = new Map<string, number[]>();
    private lastUserInteractionTime = 0;
    private startedAt = Date.now();
    private thinkingEnabled = new Map<string, boolean>();
    private activityBuffer: ActivityEntry[] = [];
    private activeSource = new Map<string, { type: string; wsClientId?: string }>();

    constructor(config: Config, sessionManager?: SessionManager) {
        this.config = config;
        this.sessionManager = sessionManager ?? new SessionManager(config);
        this.tracker = new Tracker(config.tracking);

        if (config.server) {
            this.httpServer = new HttpServer(config.server, this);
            this.httpServer.setWebhookHandler((req) => this.handleWebhook(req));
        }
    }

    getLastUserInteractionTime(): number {
        return this.lastUserInteractionTime;
    }

    getUptime(): number {
        return Date.now() - this.startedAt;
    }

    getSchedulerStatus(): { total: number; enabled: number; names: string[] } {
        if (!this.scheduler) return { total: 0, enabled: 0, names: [] };
        const jobs = this.scheduler.getJobs();
        const names: string[] = [];
        let enabled = 0;
        for (const [name, active] of jobs) {
            names.push(name);
            if (active.definition.enabled) enabled++;
        }
        return { total: names.length, enabled, names };
    }

    getThinkingEnabled(sessionName?: string): boolean {
        const name = sessionName ?? this.sessionManager.getDefaultSessionName();
        return this.thinkingEnabled.get(name) ?? false;
    }

    setThinkingEnabled(sessionName: string, enabled: boolean): void {
        this.thinkingEnabled.set(sessionName, enabled);
    }

    getUsageStats(): {
        today: { inputTokens: number; outputTokens: number; cost: number; messageCount: number };
        week: { cost: number };
    } | null {
        const today = this.tracker.today();
        const week = this.tracker.week();
        return { today, week: { cost: week.cost } };
    }

    setScheduler(scheduler: Scheduler): void {
        this.scheduler = scheduler;
    }

    getSessionManager(): SessionManager {
        return this.sessionManager;
    }

    addListener(listener: Listener): void {
        this.listeners.push(listener);
    }

    getTracker(): Tracker {
        return this.tracker;
    }

    // ─── DashboardProvider implementation ─────────────────────

    getModel(): string {
        return this.tracker.currentModel();
    }

    getContextSize(): number {
        return this.tracker.currentContext();
    }

    getListenerCount(): number {
        return this.listeners.length;
    }

    getStartedAt(): number {
        return this.startedAt;
    }

    getCronJobs(): Array<{ name: string; schedule: string; enabled: boolean }> {
        if (!this.scheduler) return [];
        const jobs = this.scheduler.getJobs();
        const result: Array<{ name: string; schedule: string; enabled: boolean }> = [];
        for (const [, active] of jobs) {
            result.push({
                name: active.definition.name,
                schedule: active.definition.schedule,
                enabled: active.definition.enabled,
            });
        }
        return result;
    }

    getUsage(): {
        today: { inputTokens: number; outputTokens: number; cost: number; messageCount: number };
        week: { cost: number };
        contextSize: number;
    } {
        const today = this.tracker.today();
        const week = this.tracker.week();
        return {
            today,
            week: { cost: week.cost },
            contextSize: this.tracker.currentContext(),
        };
    }

    getActivity(): ActivityEntry[] {
        return [...this.activityBuffer];
    }

    getLogs(): Array<{ timestamp: string; level: string; message: string; [key: string]: unknown }> {
        return getLogBuffer() as Array<{ timestamp: string; level: string; message: string; [key: string]: unknown }>;
    }

    getSessionNames(): string[] {
        return this.sessionManager.getSessionNames();
    }

    getSessionState(name: string): SessionStateInfo | null {
        const info = this.sessionManager.getSessionInfo(name);
        if (!info) return null;
        return {
            name: info.name,
            state: info.state,
            lastActivity: info.lastActivity || undefined,
        };
    }

    getUsageBySession(name: string): {
        today: { inputTokens: number; outputTokens: number; cost: number; messageCount: number };
    } | null {
        if (!this.sessionManager.getSessionInfo(name)) return null;
        return { today: this.tracker.todayBySession(name) };
    }

    private recordActivity(msg: IncomingMessage, responseTimeMs: number): void {
        if (this.activityBuffer.length >= ACTIVITY_BUFFER_CAPACITY) {
            this.activityBuffer.shift();
        }
        this.activityBuffer.push({
            sender: msg.sender,
            platform: msg.platform,
            channel: msg.channel,
            timestamp: Date.now(),
            responseTimeMs,
        });
    }

    async start(): Promise<void> {
        // Load persisted usage log before processing events
        await this.tracker.loadLog();

        // Track usage and forward events from all sessions
        this.sessionManager.on("session:event", (_sessionName: string, event: any) => {
            if (event.type === "message_end") {
                this.recordUsage(event, _sessionName);
            }
            // Forward session events to the right destination
            if (this.httpServer) {
                const source = this.activeSource.get(_sessionName);
                const sourceType = source?.type ?? "unknown";
                if (source?.wsClientId) {
                    // Websocket-initiated: send only to the originating client
                    this.httpServer.sendToClient(source.wsClientId, { ...event, source: sourceType });
                } else {
                    // Non-websocket (discord, cron, webhook): broadcast to all for monitoring
                    this.httpServer.broadcastEvent({ ...event, source: sourceType });
                }
            }
            // Clear source when agent finishes (streaming complete)
            if (event.type === "agent_end") {
                this.activeSource.delete(_sessionName);
            }
        });

        // Handle unexpected session exits
        this.sessionManager.on("session:exit", (sessionName: string, code: number) => {
            if (this.stopping) return;
            // For single-session (backward compat), crash like before
            if (this.sessionManager.getSessionNames().length === 1) {
                logger.error("Pi exited unexpectedly, shutting down", { session: sessionName, code });
                this.stop().then(() => process.exit(1));
            } else {
                logger.warn("Session exited unexpectedly", { session: sessionName, code });
            }
        });

        for (const listener of this.listeners) {
            listener.onMessage((msg) => this.handleMessage(msg));
            await listener.connect();
        }

        if (this.scheduler) {
            this.scheduler.on("response", ({ job, response }: { job: JobDefinition; response: string }) => {
                this.handleSchedulerResponse(job, response).catch((err) => {
                    logger.error("Unhandled error in scheduler response", { job: job.name, error: String(err) });
                });
            });
            this.scheduler.on("job-start", ({ session }: { job: string; session: string }) => {
                this.activeSource.set(session, { type: "cron" });
            });
            this.scheduler.on("job-end", ({ session }: { job: string; session: string }) => {
                this.activeSource.delete(session);
            });
            await this.scheduler.start();
        }

        if (this.httpServer) {
            // Wire WebSocket: forward WS commands to the appropriate session's bridge
            this.httpServer.setWsHandler(async (msg: any, clientId: string) => {
                const { type, session, ...params } = msg;
                const sessionName = session ?? this.sessionManager.getDefaultSessionName();
                const bridge = await this.sessionManager.getOrStartSession(sessionName);
                this.activeSource.set(sessionName, { type: "websocket", wsClientId: clientId });
                return bridge.command(type, params);
            });
            await this.httpServer.start();

            // Wire file roots if configured
            const roots = this.resolveFileRoots();
            if (roots && Object.keys(roots).length > 0) {
                const workspaceFiles = new WorkspaceFiles(roots);
                this.httpServer.setFiles(workspaceFiles);
                logger.info("File roots configured", { roots: Object.keys(roots) });
            }

            // Wire extensions if configured
            if (this.config.extensions?.dir) {
                this.httpServer.setExtensions(this.config.extensions);
                logger.info("Extensions configured", { dir: this.config.extensions.dir });
            }
        }

        logger.info("nest started", {
            listeners: this.listeners.length,
            sessions: this.sessionManager.getSessionNames(),
        });
    }

    async stop(): Promise<void> {
        this.stopping = true;
        if (this.httpServer) {
            await this.httpServer.stop();
        }
        if (this.scheduler) {
            await this.scheduler.stop();
        }
        for (const listener of this.listeners) {
            await listener.disconnect().catch(() => {});
        }
        await this.sessionManager.stopAll();
    }

    private resolveFileRoots(): Record<string, string> | null {
        if (this.config.files?.roots && Object.keys(this.config.files.roots).length > 0) {
            return this.config.files.roots;
        }
        return null;
    }

    private parseCommand(text: string): { name: string; args: string } | null {
        if (!text.toLowerCase().startsWith(COMMAND_PREFIX)) return null;
        const rest = text.slice(COMMAND_PREFIX.length).trim();
        if (!rest) return null;
        const [rawName, ...argParts] = rest.split(/\s+/);
        const name = rawName.toLowerCase();
        if (!commandMap.has(name)) return null;
        return { name, args: argParts.join(" ") };
    }

    private async handleMessage(msg: IncomingMessage): Promise<void> {
        if (!this.config.security.allowed_users.includes(msg.sender)) {
            logger.info("Ignored message from unauthorized user", { sender: msg.sender });
            return;
        }

        if (msg.text.length > MAX_MESSAGE_LENGTH) {
            logger.warn("Dropped oversized message", {
                sender: msg.sender,
                length: msg.text.length,
                max: MAX_MESSAGE_LENGTH,
            });
            return;
        }

        if (this.isRateLimited(msg.sender)) {
            logger.warn("Rate limited user", { sender: msg.sender });
            return;
        }

        this.lastUserInteractionTime = Date.now();

        const origin: MessageOrigin = {
            platform: msg.platform,
            channel: msg.channel,
        };
        const listener = this.listeners.find((l) => l.name === msg.platform);
        const reply = async (text: string) => {
            if (listener) await listener.send(origin, text).catch(() => {});
        };

        // Resolve which session this message routes to
        const sessionName = this.sessionManager.resolveSession(msg.platform, msg.channel);

        // Handle bot commands before passing to the agent
        const parsed = this.parseCommand(msg.text);
        if (parsed) {
            const command = commandMap.get(parsed.name)!;
            logger.info("Handling command", { command: parsed.name, sender: msg.sender, session: sessionName });

            // Get the bridge for this session (lazy start)
            let bridge: Bridge;
            try {
                bridge = await this.sessionManager.getOrStartSession(sessionName);
            } catch (err) {
                logger.error("Failed to get session for command", { session: sessionName, error: String(err) });
                await reply(`❌ Session error: ${String(err)}`);
                return;
            }

            if (command.interrupts) {
                bridge.cancelPending(`Interrupted by bot!${parsed.name}`);
            }

            this.commandRunning = true;
            try {
                await command.execute({
                    args: parsed.args,
                    bridge,
                    reply,
                    daemon: this,
                    sessionName,
                    sessionManager: this.sessionManager,
                });
            } catch (err) {
                logger.error("Command failed", { command: parsed.name, error: String(err) });
                await reply(`❌ Command failed: ${String(err)}`);
            } finally {
                this.commandRunning = false;
            }
            return;
        }

        // Process attachments: images → base64 for pi, others → inbox paths
        const { images, fileLines } = await this.processAttachments(msg.attachments);

        let promptText = `[${msg.platform} ${msg.channel}] ${msg.sender}: ${msg.text}`;
        if (fileLines.length > 0) {
            promptText += "\n" + fileLines.join("\n");
        }

        // If a command is running (e.g. compact), don't send prompts —
        // pi may drop them or leave the response queue dangling.
        if (this.commandRunning) {
            logger.info("Message deferred, command running", { sender: msg.sender });
            await reply("⏳ Hold on, running a command...");
            return;
        }

        // Get the bridge for this session (lazy start)
        let bridge: Bridge;
        try {
            bridge = await this.sessionManager.getOrStartSession(sessionName);
        } catch (err) {
            logger.error("Failed to get session", { session: sessionName, error: String(err) });
            await reply(`❌ Failed to start session '${sessionName}': ${String(err)}`);
            return;
        }

        // Record activity on the session (resets idle timer)
        this.sessionManager.recordActivity(sessionName);
        this.activeSource.set(sessionName, { type: msg.platform });

        // If the agent is mid-chain, steer instead of queuing a new prompt
        if (bridge.busy) {
            logger.info("Steering active agent", { sender: msg.sender, session: sessionName });
            bridge.steer(promptText);
            return;
        }

        // Show typing indicator while the agent is working
        const typingInterval = this.startTyping(listener, origin);

        // Accumulate files from the `attach` tool during this response
        const pendingFiles: OutgoingFile[] = [];
        const pendingReads: Promise<void>[] = [];
        const activityStart = Date.now();

        try {
            const response = await bridge.sendMessage(promptText, {
                images: images.length > 0 ? images : undefined,
                onToolStart: (info) => {
                    if (!listener) return;
                    const summary = formatToolCall(info);
                    listener.send(origin, summary).catch((err) => {
                        logger.error("Failed to send tool update", { error: String(err) });
                    });
                },
                onToolEnd: (info: ToolEndInfo) => {
                    if (info.toolName === "attach" && !info.isError && info.result?.details) {
                        const filePath = info.result.details.path;
                        if (typeof filePath === "string") {
                            pendingReads.push(
                                this.queueAttachFile(filePath, info.result.details.filename, pendingFiles),
                            );
                        }
                    }
                },
                onText: (text) => {
                    if (!listener) return;
                    listener.send(origin, text).catch((err) => {
                        logger.error("Failed to send intermediate text", { error: String(err) });
                    });
                },
            });

            if (!response) return;

            // Wait for any pending file reads before sending
            await Promise.all(pendingReads);

            if (listener) {
                await listener.send(origin, response, pendingFiles.length > 0 ? pendingFiles : undefined);
            }
        } catch (err) {
            logger.error("Failed to process message", { error: String(err), session: sessionName });
        } finally {
            this.activeSource.delete(sessionName);
            this.recordActivity(msg, Date.now() - activityStart);
            clearInterval(typingInterval);
        }
    }

    private async handleSchedulerResponse(job: JobDefinition, response: string): Promise<void> {
        const notifyRoom = this.resolveNotify(job);
        if (!notifyRoom) return;
        await this.sendToRoom(notifyRoom, response, `cron:${job.name}`);
    }

    private async handleWebhook(req: WebhookRequest): Promise<WebhookResult> {
        // Resolve session: use req.session if provided, otherwise default
        const sessionName = req.session ?? this.sessionManager.getDefaultSessionName();

        let bridge: Bridge;
        try {
            bridge = await this.sessionManager.getOrStartSession(sessionName);
        } catch (err) {
            return { ok: false, error: `Session error: ${String(err)}` };
        }

        this.sessionManager.recordActivity(sessionName);
        this.activeSource.set(sessionName, { type: "webhook" });

        const prefix = req.source ? `[webhook ${req.source}]` : `[webhook]`;
        const prompt = `${prefix} ${req.message}`;

        if (bridge.busy) {
            // Fire-and-forget: the bridge queues it with followUp behavior
            bridge.sendMessage(prompt).then((response) => {
                if (req.notify) {
                    this.sendToRoom(req.notify, response, `webhook:${req.source ?? "unknown"}`).catch((err) => {
                        logger.error("Failed to send queued webhook response", { error: String(err) });
                    });
                }
            }).catch((err) => {
                logger.error("Queued webhook message failed", { error: String(err) });
            });

            return { ok: true, queued: true };
        }

        try {
            const response = await bridge.sendMessage(prompt);

            if (req.notify) {
                await this.sendToRoom(req.notify, response, `webhook:${req.source ?? "unknown"}`);
            }

            return { ok: true, response };
        } finally {
            this.activeSource.delete(sessionName);
        }
    }

    private async sendToRoom(roomId: string, text: string, label: string): Promise<void> {
        const [platform, channel] = this.parseRoomId(roomId);

        if (!platform || !channel) {
            logger.error("Invalid notify room format", { roomId, label });
            return;
        }

        const origin: MessageOrigin = { platform, channel };
        const listener = this.listeners.find((l) => l.name === platform);

        if (listener) {
            try {
                await listener.send(origin, text);
            } catch (err) {
                logger.error("Failed to send to room", { roomId, label, error: String(err) });
            }
        } else {
            logger.error("No listener found for platform", { platform, label });
        }
    }

    private resolveNotify(job: JobDefinition): string | null {
        if (job.notify === "none") return null;
        if (job.notify) return job.notify;
        return this.config.cron?.default_notify ?? null;
    }

    private parseRoomId(roomId: string): [string | null, string | null] {
        if (roomId.startsWith("#") && roomId.includes(":")) {
            return ["matrix", roomId];
        } else if (/^\d+$/.test(roomId)) {
            return ["discord", roomId];
        }
        return [null, null];
    }

    private recordUsage(event: any, sessionName: string): void {
        if (event.type !== "message_end") return;

        // message_end has per-message usage: { input, output, cacheRead, cacheWrite, cost }
        const msg = event.message;
        if (!msg || msg.role !== "assistant") return;

        const usage = msg.usage ?? {};
        const model = msg.model ?? "unknown";
        const inputTokens = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
        const outputTokens = usage.output ?? 0;

        // Context size = total tokens the model saw for this response
        const contextSize = usage.totalTokens || (inputTokens + outputTokens);

        // Use pi's reported cost directly instead of estimating from rates
        const cost = usage.cost?.total ?? 0;

        const recorded = this.tracker.record({ model, inputTokens, outputTokens, contextSize, cost, sessionName });
        logger.info("Usage recorded", {
            session: sessionName,
            model: recorded.model,
            inputTokens: recorded.inputTokens,
            outputTokens: recorded.outputTokens,
            contextSize: recorded.contextSize,
            cost: recorded.cost.toFixed(6),
        });
    }

    private async processAttachments(
        attachments?: Attachment[],
    ): Promise<{ images: ImageContent[]; fileLines: string[] }> {
        const images: ImageContent[] = [];
        const fileLines: string[] = [];

        if (!attachments || attachments.length === 0) {
            return { images, fileLines };
        }

        // Clean up old inbox files (non-blocking)
        cleanupInbox().catch((err) => {
            logger.error("Inbox cleanup failed", { error: String(err) });
        });

        for (const att of attachments) {
            if (att.base64 && att.contentType.startsWith("image/")) {
                const compressed = att.data
                    ? await compressImage(att.data, att.contentType)
                    : null;
                if (compressed && !compressed.ok) {
                    // Image couldn't be compressed — include as text warning
                    fileLines.push(`[${compressed.reason}]`);
                } else if (compressed && compressed.ok) {
                    images.push({
                        type: "image",
                        data: compressed.base64,
                        mimeType: compressed.mimeType,
                    });
                } else {
                    // null = already fits, use original
                    images.push({
                        type: "image",
                        data: att.base64,
                        mimeType: att.contentType,
                    });
                }
            } else if (att.data) {
                const saved = await saveToInbox(att.filename, att.data);
                if (saved) {
                    fileLines.push(`[Attached file: ${saved} (${att.contentType}, ${att.size} bytes)]`);
                }
            }
        }

        return { images, fileLines };
    }

    private async queueAttachFile(
        filePath: string,
        filename: string | undefined,
        pendingFiles: OutgoingFile[],
    ): Promise<void> {
        try {
            const data = await readFile(filePath);
            pendingFiles.push({
                data,
                filename: filename ?? basename(filePath),
            });
        } catch (err) {
            logger.error("Failed to read attach file", { path: filePath, error: String(err) });
        }
    }

    private startTyping(listener: Listener | undefined, origin: MessageOrigin): ReturnType<typeof setInterval> {
        const send = () => {
            listener?.sendTyping?.(origin).catch((err) => {
                logger.error("Failed to send typing indicator", { error: String(err) });
            });
        };
        send(); // fire immediately
        return setInterval(send, 8_000); // refresh every 8s (Discord typing lasts ~10s)
    }

    private isRateLimited(sender: string): boolean {
        const now = Date.now();
        const timestamps = this.rateLimits.get(sender) ?? [];
        const recent = timestamps.filter((t) => now - t < RATE_WINDOW_MS);

        if (recent.length >= RATE_MAX_PER_WINDOW) {
            this.rateLimits.set(sender, recent);
            return true;
        }

        recent.push(now);
        this.rateLimits.set(sender, recent);
        return false;
    }
}
