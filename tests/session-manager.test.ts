import { describe, it, expect, vi, beforeEach } from "vitest";
import { SessionManager } from "../src/session-manager.js";
import { MockListener, makeMessage } from "./helpers.js";
import type { Config } from "../src/types.js";

function makeConfig(overrides?: Partial<Config>): Config {
    return {
        sessions: {
            main: { pi: { cwd: "/tmp" } },
            background: { pi: { cwd: "/tmp" } },
        },
        defaultSession: "main",
        ...overrides,
    };
}

function makeMockBridge() {
    return {
        start: vi.fn(),
        stop: vi.fn().mockResolvedValue(undefined),
        on: vi.fn(),
        removeAllListeners: vi.fn(),
        busy: false,
        sendMessage: vi.fn().mockResolvedValue("response"),
        command: vi.fn().mockResolvedValue({}),
        emit: vi.fn(),
    } as any;
}

describe("SessionManager", () => {
    let sm: SessionManager;
    let mockBridge: any;

    beforeEach(() => {
        mockBridge = makeMockBridge();
        sm = new SessionManager(makeConfig(), () => mockBridge);
    });

    it("lists configured sessions", () => {
        expect(sm.getSessionNames()).toEqual(["main", "background"]);
    });

    it("returns default session name", () => {
        expect(sm.getDefaultSessionName()).toBe("main");
    });

    it("starts a session lazily", async () => {
        const bridge = await sm.getOrStartSession("main");
        expect(bridge).toBe(mockBridge);
        expect(mockBridge.start).toHaveBeenCalled();
    });

    it("throws for unknown session", async () => {
        await expect(sm.getOrStartSession("unknown")).rejects.toThrow("Unknown session");
    });

    describe("attach/detach", () => {
        it("attaches a listener to a session", () => {
            const listener = new MockListener("discord");
            sm.attach("main", listener, { platform: "discord", channel: "123" });
            const bindings = sm.getListeners("main");
            expect(bindings).toHaveLength(1);
            expect(bindings[0].listener.name).toBe("discord");
            expect(bindings[0].origin.channel).toBe("123");
        });

        it("prevents duplicate attachments", () => {
            const listener = new MockListener("discord");
            sm.attach("main", listener, { platform: "discord", channel: "123" });
            sm.attach("main", listener, { platform: "discord", channel: "123" });
            expect(sm.getListeners("main")).toHaveLength(1);
        });

        it("allows same listener on different channels", () => {
            const listener = new MockListener("discord");
            sm.attach("main", listener, { platform: "discord", channel: "123" });
            sm.attach("main", listener, { platform: "discord", channel: "456" });
            expect(sm.getListeners("main")).toHaveLength(2);
        });

        it("detaches a listener", () => {
            const listener = new MockListener("discord");
            sm.attach("main", listener, { platform: "discord", channel: "123" });
            sm.detach("main", listener);
            expect(sm.getListeners("main")).toHaveLength(0);
        });

        it("throws when attaching to unknown session", () => {
            const listener = new MockListener();
            expect(() => sm.attach("unknown", listener, { platform: "test", channel: "x" }))
                .toThrow("Unknown session");
        });
    });

    describe("broadcast", () => {
        it("sends to all attached listeners", async () => {
            const l1 = new MockListener("discord");
            const l2 = new MockListener("cli");
            sm.attach("main", l1, { platform: "discord", channel: "123" });
            sm.attach("main", l2, { platform: "cli", channel: "tty" });

            await sm.broadcast("main", "hello everyone");
            expect(l1.sent).toHaveLength(1);
            expect(l1.sent[0].text).toBe("hello everyone");
            expect(l2.sent).toHaveLength(1);
            expect(l2.sent[0].text).toBe("hello everyone");
        });

        it("sends nothing if no listeners", async () => {
            await sm.broadcast("main", "nobody here");
            // No error thrown
        });
    });
});
