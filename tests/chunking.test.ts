import { describe, it, expect } from "vitest";
import { splitMessage } from "../src/chunking.js";

describe("splitMessage", () => {
    it("returns original if under limit", () => {
        expect(splitMessage("hello")).toEqual(["hello"]);
    });

    it("splits at paragraph boundary", () => {
        const text = "a".repeat(1950) + "\n\n" + "b".repeat(100);
        const chunks = splitMessage(text);
        expect(chunks.length).toBe(2);
    });

    it("handles code blocks across splits", () => {
        const code = "```js\n" + "x = 1;\n".repeat(300) + "```";
        const chunks = splitMessage(code);
        expect(chunks.length).toBeGreaterThan(1);
        // Each chunk should have balanced fences
        for (const chunk of chunks) {
            const fences = (chunk.match(/```/g) ?? []).length;
            expect(fences % 2).toBe(0);
        }
    });
});
