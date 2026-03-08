import { readFileSync } from "node:fs";
import yaml from "js-yaml";
import type { Config, SessionConfig } from "./types.js";

export function loadConfig(path: string): Config {
    const raw = readFileSync(path, "utf-8");
    const parsed = yaml.load(raw) as Record<string, unknown>;
    const resolved = resolveEnvVars(parsed) as Record<string, unknown>;
    validate(resolved);
    return resolved as unknown as Config;
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

function validate(config: Record<string, unknown>): void {
    // Sessions are required
    if (!config.sessions || typeof config.sessions !== "object" || Array.isArray(config.sessions)) {
        throw new Error("config: sessions is required and must be an object");
    }

    const sessions = config.sessions as Record<string, unknown>;
    for (const [name, session] of Object.entries(sessions)) {
        const s = session as Record<string, any>;
        if (!s?.pi?.cwd) {
            throw new Error(`config: sessions.${name}.pi.cwd is required`);
        }
    }

    // Default session
    const defaultSession = (config.defaultSession as string) ?? Object.keys(sessions)[0];
    if (!sessions[defaultSession]) {
        throw new Error(`config: defaultSession '${defaultSession}' not found in sessions`);
    }
    config.defaultSession = defaultSession;

    // Server validation
    if (config.server) {
        const s = config.server as Record<string, any>;
        if (typeof s.port !== "number" || s.port < 1 || s.port > 65535) {
            throw new Error("config: server.port must be a number between 1 and 65535");
        }
        if (!s.token || typeof s.token !== "string") {
            throw new Error("config: server.token is required");
        }
    }

    // Cron validation
    if (config.cron) {
        const c = config.cron as Record<string, any>;
        if (!c.dir || typeof c.dir !== "string") {
            throw new Error("config: cron.dir is required and must be a string");
        }
    }

    // Instance defaults
    if (!config.instance) {
        config.instance = {};
    }
    const inst = config.instance as Record<string, any>;
    if (!inst.name) inst.name = "nest";
    if (!inst.dataDir) inst.dataDir = ".";
    if (!inst.pluginsDir) inst.pluginsDir = "./plugins";
}

export function serializeConfig(config: Config): string {
    return yaml.dump(config, { lineWidth: -1, noRefs: true, sortKeys: true });
}
