import { readFileSync } from "node:fs";
import yaml from "js-yaml";
import type { Config, ConfigChange, ConfigDiff, ConfigRedacted } from "./types.js";

export function loadConfig(path: string): Config {
    const raw = readFileSync(path, "utf-8");
    const parsed = yaml.load(raw) as Record<string, unknown>;
    const resolved = resolveEnvVars(parsed);
    validate(resolved);
    return resolved as Config;
}

function resolveEnvVars(obj: unknown): unknown {
    if (typeof obj === "string" && obj.startsWith("env:")) {
        const name = obj.slice(4);
        const value = process.env[name];
        if (!value) throw new Error(`Environment variable ${name} not set`);
        return value;
    }
    if (Array.isArray(obj)) return obj.map(resolveEnvVars);
    if (obj && typeof obj === "object") {
        const result: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(obj)) {
            result[key] = resolveEnvVars(value);
        }
        return result;
    }
    return obj;
}

function validate(config: unknown): asserts config is Config {
    const c = config as Record<string, any>;
    if (!c.pi?.cwd) throw new Error("config: pi.cwd is required");
    if (!Array.isArray(c.security?.allowed_users) || c.security.allowed_users.length === 0) {
        throw new Error("config: security.allowed_users must have at least one entry");
    }
    if (c.cron) {
        if (!c.cron.dir || typeof c.cron.dir !== "string") {
            throw new Error("config: cron.dir is required and must be a string");
        }
    }
    if (c.server) {
        if (typeof c.server.port !== "number" || c.server.port < 1 || c.server.port > 65535) {
            throw new Error("config: server.port must be a number between 1 and 65535");
        }
        if (!c.server.token || typeof c.server.token !== "string") {
            throw new Error("config: server.token is required");
        }
        if (c.server.cors?.origin === "*") {
            throw new Error(
                "config: server.cors.origin cannot be '*' — browsers block credentials (Bearer auth) " +
                "with wildcard origins. Use an explicit origin like 'https://example.com'."
            );
        }
        if (c.server.trustProxy !== undefined && typeof c.server.trustProxy !== "boolean") {
            throw new Error("config: server.trustProxy must be a boolean");
        }
        if (c.server.host !== undefined) {
            if (typeof c.server.host !== "string") {
                throw new Error("config: server.host must be a string");
            }
            if (!/^(\d{1,3}\.){3}\d{1,3}$|^[a-zA-Z0-9.-]+$|^\[:[:0-9a-fA-F]+\]$/.test(c.server.host)) {
                throw new Error("config: server.host must be a valid IP address or hostname");
            }
        }
    }
    if (c.files) {
        if (!c.files.roots || typeof c.files.roots !== "object" || Array.isArray(c.files.roots)) {
            throw new Error("config: files.roots must be an object mapping names to paths");
        }
        for (const [name, path] of Object.entries(c.files.roots)) {
            if (typeof path !== "string" || !path) {
                throw new Error(`config: files.roots.${name} must be a non-empty string`);
            }
        }
    }

    if (c.extensions) {
        if (!c.extensions.dir || typeof c.extensions.dir !== "string") {
            throw new Error("config: extensions.dir is required and must be a string");
        }
    }

    validateSessions(c);
    validateRouting(c);
}

function validateSessions(c: Record<string, any>): void {
    if (!c.sessions) return;
    if (typeof c.sessions !== "object" || Array.isArray(c.sessions)) {
        throw new Error("config: sessions must be an object mapping session names to configs");
    }
    for (const [name, session] of Object.entries(c.sessions)) {
        const s = session as Record<string, any>;
        if (!s?.pi?.cwd) {
            throw new Error(`config: sessions.${name}.pi.cwd is required`);
        }
    }
    if (c.defaultSession && typeof c.defaultSession === "string") {
        if (!c.sessions[c.defaultSession]) {
            throw new Error(`config: defaultSession '${c.defaultSession}' not found in sessions`);
        }
    }
}

function validateRouting(c: Record<string, any>): void {
    if (!c.routing) return;
    const routing = c.routing;
    if (typeof routing !== "object" || Array.isArray(routing)) {
        throw new Error("config: routing must be an object with rules and default");
    }
    // Determine available session names
    const sessionNames = c.sessions
        ? new Set(Object.keys(c.sessions))
        : new Set(["main"]);

    if (routing.default && typeof routing.default === "string") {
        if (!sessionNames.has(routing.default)) {
            throw new Error(`config: routing.default '${routing.default}' not found in sessions`);
        }
    }
    if (routing.rules) {
        if (!Array.isArray(routing.rules)) {
            throw new Error("config: routing.rules must be an array");
        }
        for (let i = 0; i < routing.rules.length; i++) {
            const rule = routing.rules[i];
            if (!rule.session || typeof rule.session !== "string") {
                throw new Error(`config: routing.rules[${i}].session is required`);
            }
            if (!sessionNames.has(rule.session)) {
                throw new Error(`config: routing.rules[${i}].session '${rule.session}' not found in sessions`);
            }
            if (!rule.match || typeof rule.match !== "object") {
                throw new Error(`config: routing.rules[${i}].match is required`);
            }
        }
    }
}

// ─── Config Reload Utilities ──────────────────────────────────

/** Sections/keys that require a restart to take effect */
const RESTART_REQUIRED: Set<string> = new Set([
    "discord.token",
    "matrix.homeserver",
    "matrix.user",
    "matrix.token",
    "matrix.storage_path",
    "server.port",
    "server.token",
]);

/** Sensitive fields that should be redacted in API/command output */
const SENSITIVE_FIELDS: Set<string> = new Set([
    "discord.token",
    "matrix.token",
    "server.token",
]);

/** Redact sensitive fields from config for display */
export function redactConfig(config: Config): ConfigRedacted {
    const redacted = structuredClone(config) as any;
    if (redacted.discord?.token) redacted.discord.token = "***";
    if (redacted.matrix?.token) redacted.matrix.token = "***";
    if (redacted.server?.token) redacted.server.token = "***";
    return redacted as ConfigRedacted;
}

/** Diff two configs and classify each change as hot-reloadable or restart-required */
export function diffConfig(oldConfig: Config, newConfig: Config): ConfigDiff {
    const changes: ConfigChange[] = [];

    const oldFlat = flattenObject(oldConfig as unknown as Record<string, unknown>);
    const newFlat = flattenObject(newConfig as unknown as Record<string, unknown>);

    const allKeys = new Set([...Object.keys(oldFlat), ...Object.keys(newFlat)]);

    for (const key of allKeys) {
        const oldVal = oldFlat[key];
        const newVal = newFlat[key];

        if (!deepEqual(oldVal, newVal)) {
            const dotIdx = key.indexOf(".");
            const section = dotIdx > -1 ? key.slice(0, dotIdx) : key;
            const subKey = dotIdx > -1 ? key.slice(dotIdx + 1) : "";

            changes.push({
                section,
                key: subKey || section,
                oldValue: oldVal,
                newValue: newVal,
                hotReloadable: !RESTART_REQUIRED.has(key),
            });
        }
    }

    return {
        changes,
        hasRestartRequired: changes.some((c) => !c.hotReloadable),
        hasHotReloadable: changes.some((c) => c.hotReloadable),
    };
}

/** Flatten a nested object into dot-separated keys */
function flattenObject(obj: Record<string, unknown>, prefix = ""): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(obj)) {
        const fullKey = prefix ? `${prefix}.${key}` : key;

        if (value && typeof value === "object" && !Array.isArray(value)) {
            Object.assign(result, flattenObject(value as Record<string, unknown>, fullKey));
        } else {
            result[fullKey] = value;
        }
    }

    return result;
}

/** Deep equality check for config values */
function deepEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (a == null || b == null) return a === b;
    if (typeof a !== typeof b) return false;

    if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length !== b.length) return false;
        return a.every((v, i) => deepEqual(v, b[i]));
    }

    if (typeof a === "object" && typeof b === "object") {
        const aKeys = Object.keys(a as Record<string, unknown>);
        const bKeys = Object.keys(b as Record<string, unknown>);
        if (aKeys.length !== bKeys.length) return false;
        return aKeys.every((k) =>
            deepEqual(
                (a as Record<string, unknown>)[k],
                (b as Record<string, unknown>)[k],
            ),
        );
    }

    return false;
}

/** Merge a partial config into the existing config (shallow per top-level section) */
export function mergeConfig(base: Config, partial: Record<string, unknown>): Config {
    const merged = structuredClone(base) as unknown as Record<string, unknown>;

    for (const [section, value] of Object.entries(partial)) {
        if (value && typeof value === "object" && !Array.isArray(value) &&
            merged[section] && typeof merged[section] === "object" && !Array.isArray(merged[section])) {
            merged[section] = { ...(merged[section] as Record<string, unknown>), ...(value as Record<string, unknown>) };
        } else {
            merged[section] = value;
        }
    }

    return merged as unknown as Config;
}

/** Serialize config back to YAML (stripping undefined values) */
export function serializeConfig(config: Config): string {
    return yaml.dump(config, { lineWidth: -1, noRefs: true, sortKeys: true });
}
