export interface Attachment {
    url: string;
    filename: string;
    contentType: string;
    size: number;
    data?: Buffer;
    base64?: string;
}

export interface OutgoingFile {
    data: Buffer;
    filename: string;
}

export interface IncomingMessage {
    platform: string;
    channel: string;
    sender: string;
    text: string;
    attachments?: Attachment[];
}

export interface MessageOrigin {
    platform: string;
    channel: string;
}

export interface Listener {
    readonly name: string;
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    onMessage(handler: (msg: IncomingMessage) => void): void;
    send(origin: MessageOrigin, text: string, files?: OutgoingFile[]): Promise<void>;
    sendTyping?(origin: MessageOrigin): Promise<void>;
}

export interface ToolCallInfo {
    toolName: string;
    args: Record<string, any>;
}

export interface ToolEndInfo {
    toolName: string;
    toolCallId: string;
    result?: {
        content: Array<{ type: string; text?: string }>;
        details?: Record<string, any>;
    };
    isError: boolean;
}

export interface CorsConfig {
    origin: string;
}

export interface ServerConfig {
    port: number;
    token: string;
    publicDir?: string;
    cors?: CorsConfig;
    trustProxy?: boolean;
    host?: string;
}

// ─── Session & Routing Types ──────────────────────────────────

export type SessionState = "idle" | "starting" | "running" | "stopping";

export interface SessionConfig {
    pi: {
        cwd: string;
        command?: string;
        args?: string[];
        extensions?: string[];
    };
    idleTimeoutMinutes?: number;
}

export interface RoutingRule {
    match: {
        platform?: string;
        channel?: string;
    };
    session: string;
}

export interface RoutingConfig {
    rules: RoutingRule[];
    default: string;
}

// ─── Files Types ──────────────────────────────────────────────

export interface FilesConfig {
    roots: Record<string, string>;
}

export interface FileEntry {
    name: string;
    path: string;
    type: "file" | "dir";
    children?: FileEntry[];
}

// ─── Extensions Types ─────────────────────────────────────────

export interface ExtensionsConfig {
    dir: string;
}

export interface ExtensionSlotConfig {
    type: 'dashboard' | 'sidebar' | 'toolbar' | 'viewer';
    entry: string;
    defaultHeight?: number;
}

export interface ExtensionManifest {
    id: string;
    name: string;
    version: number;
    slots: ExtensionSlotConfig[];
    // Backward compat with old manifests (entry + optional styles, no slots)
    entry?: string;
    styles?: string;
}

// ─── Main Config ──────────────────────────────────────────────

export interface Config {
    pi: {
        cwd: string;
        command?: string;
        args?: string[];
        extensions?: string[];
    };
    security: {
        allowed_users: string[];
    };
    matrix?: {
        homeserver: string;
        user: string;
        token: string;
        storage_path?: string;
    };
    discord?: {
        token: string;
    };
    cron?: CronConfig;
    server?: ServerConfig;
    tracking?: TrackingConfig;
    files?: FilesConfig;
    extensions?: ExtensionsConfig;
    sessions?: Record<string, SessionConfig>;
    defaultSession?: string;
    routing?: RoutingConfig;
}

export interface CronConfig {
    dir: string;
    default_notify?: string;
    gracePeriodMs?: number;
}

export interface TrackingConfig {
    usageLog?: string;
    rates?: Record<string, { input: number; output: number }>;
    capacity?: number;
    retentionDays?: number;
}

export interface UsageEvent {
    timestamp: number;
    model: string;
    inputTokens: number;
    outputTokens: number;
    contextSize: number;
    cost: number;
    compaction: boolean;
    sessionName?: string;
}

// ─── Webhook Types ────────────────────────────────────────────

export interface WebhookRequest {
    message: string;
    notify?: string;
    source?: string;
    session?: string;  // reserved for P8
}

export interface WebhookResult {
    ok: boolean;
    response?: string;
    queued?: boolean;
    error?: string;
}

/** Callback for handling inbound webhooks. Avoids circular server↔daemon imports. */
export type WebhookHandler = (req: WebhookRequest) => Promise<WebhookResult>;

export interface ActivityEntry {
    sender: string;
    platform: string;
    channel: string;
    timestamp: number;
    responseTimeMs: number;
}

export type Step =
    | { type: "new-session" }
    | { type: "compact" }
    | { type: "model"; model: string }
    | { type: "prompt" }
    | { type: "reload" };

export interface JobDefinition {
    name: string;
    file: string;
    schedule: string;
    steps: Step[];
    notify: string | "none" | null;  // null = inherit default
    enabled: boolean;
    gracePeriodMs?: number;  // per-job override; undefined = use global default
    session?: string;  // target session name; undefined = use default session
    body: string;
}

// ─── Config Reload Types ──────────────────────────────────────

/** Describes a single config field that changed */
export interface ConfigChange {
    section: string;
    key: string;
    oldValue: unknown;
    newValue: unknown;
    hotReloadable: boolean;
}

/** Result of diffing two configs */
export interface ConfigDiff {
    changes: ConfigChange[];
    hasRestartRequired: boolean;
    hasHotReloadable: boolean;
}

/** Config with sensitive fields redacted */
export type ConfigRedacted = {
    [K in keyof Config]: K extends "discord"
        ? { token: string } | undefined
        : K extends "matrix"
          ? { homeserver: string; user: string; token: string; storage_path?: string } | undefined
          : K extends "server"
            ? { port: number; token: string; publicDir?: string; cors?: CorsConfig; trustProxy?: boolean; host?: string } | undefined
            : Config[K];
};
