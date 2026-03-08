import { readFile } from "node:fs/promises";
import { basename, relative } from "node:path";
import matter from "gray-matter";
import cron from "node-cron";
import type { JobDefinition, Step } from "./types.js";

export class JobParseError extends Error {
    constructor(file: string, reason: string) {
        super(`Invalid job file ${file}: ${reason}`);
        this.name = "JobParseError";
    }
}

export function parseStep(raw: unknown): Step {
    if (typeof raw === "string") {
        switch (raw) {
            case "new-session": return { type: "new-session" };
            case "compact": return { type: "compact" };
            case "prompt": return { type: "prompt" };
            case "reload": return { type: "reload" };
            default: throw new Error(`Unknown step: ${raw}`);
        }
    }

    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        const keys = Object.keys(raw);
        if (keys.includes("model")) {
            const value = (raw as Record<string, unknown>).model;
            if (typeof value !== "string") throw new Error(`Step 'model' value must be a string`);
            return { type: "model", model: value };
        }
    }

    throw new Error(`Invalid step: ${JSON.stringify(raw)}`);
}

export function parseSteps(raw: unknown): Step[] {
    if (!Array.isArray(raw)) throw new Error("steps must be an array");
    return raw.map((step, i) => {
        try { return parseStep(step); } catch (err) {
            throw new Error(`step[${i}]: ${(err as Error).message}`);
        }
    });
}

export async function parseJobFile(filePath: string, baseDir?: string): Promise<JobDefinition> {
    const content = await readFile(filePath, "utf-8");
    return parseJobContent(content, filePath, baseDir);
}

export function parseJobContent(content: string, filePath: string, baseDir?: string): JobDefinition {
    const { data, content: body } = matter(content);

    const name = baseDir
        ? relative(baseDir, filePath).replace(/\.md$/, "").replace(/\\/g, "/")
        : basename(filePath, ".md");

    if (!data.schedule || typeof data.schedule !== "string") {
        throw new JobParseError(filePath, "schedule is required");
    }
    if (!cron.validate(data.schedule)) {
        throw new JobParseError(filePath, `invalid cron expression: ${data.schedule}`);
    }
    if (!data.steps) {
        throw new JobParseError(filePath, "steps is required");
    }

    let steps: Step[];
    try { steps = parseSteps(data.steps); } catch (err) {
        throw new JobParseError(filePath, `invalid steps: ${(err as Error).message}`);
    }

    if (steps.some((s) => s.type === "prompt") && !body.trim()) {
        throw new JobParseError(filePath, "steps include 'prompt' but file has no body");
    }

    const enabled = data.enabled !== false;

    let gracePeriodMs: number | undefined;
    if (data.gracePeriodMs !== undefined) {
        if (typeof data.gracePeriodMs !== "number" || data.gracePeriodMs < 0) {
            throw new JobParseError(filePath, "gracePeriodMs must be a non-negative number");
        }
        gracePeriodMs = data.gracePeriodMs;
    }

    let session: string | undefined;
    if (data.session !== undefined) {
        if (typeof data.session !== "string" || !data.session.trim()) {
            throw new JobParseError(filePath, "session must be a non-empty string");
        }
        session = data.session.trim();
    }

    return { name, file: filePath, schedule: data.schedule, steps, enabled, gracePeriodMs, session, body: body.trim() };
}
