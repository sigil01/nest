import { describe, it, expect, afterAll } from "vitest";
import { loadConfig } from "../src/config.js";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const TMP = join(import.meta.dirname ?? ".", ".test-config-tmp");

function writeConfig(name: string, content: string): string {
    mkdirSync(TMP, { recursive: true });
    const path = join(TMP, name);
    writeFileSync(path, content);
    return path;
}

describe("loadConfig", () => {
    it("loads a valid config with sessions", () => {
        const path = writeConfig("valid.yaml", `
sessions:
  main:
    pi:
      cwd: /tmp
defaultSession: main
`);
        const config = loadConfig(path);
        expect(config.sessions.main.pi.cwd).toBe("/tmp");
        expect(config.defaultSession).toBe("main");
    });

    it("sets defaultSession to first session if not specified", () => {
        const path = writeConfig("nodefault.yaml", `
sessions:
  wren:
    pi:
      cwd: /tmp
`);
        const config = loadConfig(path);
        expect(config.defaultSession).toBe("wren");
    });

    it("throws if sessions is missing", () => {
        const path = writeConfig("nosessions.yaml", `
pi:
  cwd: /tmp
`);
        expect(() => loadConfig(path)).toThrow("sessions is required");
    });

    it("throws if session has no pi.cwd", () => {
        const path = writeConfig("nocwd.yaml", `
sessions:
  main:
    pi: {}
`);
        expect(() => loadConfig(path)).toThrow("pi.cwd is required");
    });

    it("provides instance defaults", () => {
        const path = writeConfig("defaults.yaml", `
sessions:
  main:
    pi:
      cwd: /tmp
`);
        const config = loadConfig(path);
        expect(config.instance?.name).toBe("nest");
        expect(config.instance?.pluginsDir).toBe("./plugins");
    });

    it("passes through plugin config sections untouched", () => {
        const path = writeConfig("plugins.yaml", `
sessions:
  main:
    pi:
      cwd: /tmp
discord:
  token: test-token
  channels:
    "123": main
custom_plugin:
  foo: bar
`);
        const config = loadConfig(path);
        expect((config as any).discord.token).toBe("test-token");
        expect((config as any).custom_plugin.foo).toBe("bar");
    });

    // Cleanup
    afterAll(() => {
        try { rmSync(TMP, { recursive: true }); } catch {}
    });
});
