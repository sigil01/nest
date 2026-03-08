import { describe, it, expect } from "vitest";
import { Tracker } from "../src/tracker.js";

describe("Tracker", () => {
    it("records and queries usage", () => {
        const tracker = new Tracker();
        tracker.record({
            model: "claude-4",
            inputTokens: 1000,
            outputTokens: 500,
            cacheReadTokens: 200,
            cacheWriteTokens: 100,
            contextSize: 1800,
            cost: 0.05,
        });

        expect(tracker.size).toBe(1);
        expect(tracker.currentModel()).toBe("claude-4");
        expect(tracker.currentContext()).toBe(1800);

        const today = tracker.today();
        expect(today.messageCount).toBe(1);
        expect(today.inputTokens).toBe(1000);
        expect(today.cost).toBe(0.05);
    });

    it("filters by session", () => {
        const tracker = new Tracker();
        tracker.record({
            model: "claude-4",
            inputTokens: 1000,
            outputTokens: 500,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            contextSize: 1500,
            cost: 0.03,
            sessionName: "wren",
        });
        tracker.record({
            model: "claude-4",
            inputTokens: 2000,
            outputTokens: 1000,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            contextSize: 3000,
            cost: 0.07,
            sessionName: "background",
        });

        const wren = tracker.todayBySession("wren");
        expect(wren.messageCount).toBe(1);
        expect(wren.cost).toBe(0.03);

        const bg = tracker.todayBySession("background");
        expect(bg.messageCount).toBe(1);
        expect(bg.cost).toBe(0.07);

        const all = tracker.today();
        expect(all.messageCount).toBe(2);
        expect(all.cost).toBe(0.10);
    });

    it("respects capacity ring buffer", () => {
        const tracker = new Tracker({ capacity: 3 });
        for (let i = 0; i < 5; i++) {
            tracker.record({
                model: "m",
                inputTokens: i,
                outputTokens: 0,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                contextSize: 0,
                cost: 0,
            });
        }
        expect(tracker.size).toBe(3);
    });
});
