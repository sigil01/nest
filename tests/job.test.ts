import { describe, it, expect } from "vitest";
import { parseJobContent, parseStep, parseSteps } from "../src/job.js";

describe("parseStep", () => {
    it("parses string steps", () => {
        expect(parseStep("new-session")).toEqual({ type: "new-session" });
        expect(parseStep("compact")).toEqual({ type: "compact" });
        expect(parseStep("prompt")).toEqual({ type: "prompt" });
        expect(parseStep("reload")).toEqual({ type: "reload" });
    });

    it("parses model step", () => {
        expect(parseStep({ model: "claude-3" })).toEqual({ type: "model", model: "claude-3" });
    });

    it("throws on unknown step", () => {
        expect(() => parseStep("unknown")).toThrow("Unknown step");
    });
});

describe("parseJobContent", () => {
    it("parses a valid job", () => {
        const content = `---
schedule: "0 7 * * *"
steps:
  - new-session
  - prompt
session: wren
---
Good morning!`;

        const job = parseJobContent(content, "test.md");
        expect(job.name).toBe("test");
        expect(job.schedule).toBe("0 7 * * *");
        expect(job.steps).toHaveLength(2);
        expect(job.session).toBe("wren");
        expect(job.body).toBe("Good morning!");
        expect(job.enabled).toBe(true);
    });

    it("does not have a notify field", () => {
        const content = `---
schedule: "0 7 * * *"
steps:
  - prompt
---
hello`;
        const job = parseJobContent(content, "test.md");
        expect((job as any).notify).toBeUndefined();
    });

    it("throws if schedule is missing", () => {
        expect(() => parseJobContent("---\nsteps:\n  - prompt\n---\nhello", "test.md"))
            .toThrow("schedule is required");
    });

    it("throws if prompt step has no body", () => {
        expect(() => parseJobContent("---\nschedule: '* * * * *'\nsteps:\n  - prompt\n---\n", "test.md"))
            .toThrow("no body");
    });
});
