import { loadConfig } from "./config.js";
import { Kernel } from "./kernel.js";
import { Bridge } from "./bridge.js";
import { SessionManager } from "./session-manager.js";
import type { BridgeOptions } from "./bridge.js";
import * as logger from "./logger.js";

const configPath = process.argv[2] ?? "config.yaml";
const config = loadConfig(configPath);

// Bridge factory — injects extension flags
function createBridge(opts: BridgeOptions): Bridge {
    const sessionConfig = Object.values(config.sessions).find(
        (s) => s.pi.cwd === opts.cwd,
    );
    const extensions = sessionConfig?.pi.extensions;

    const args = [...(opts.args ?? ["--mode", "rpc", "--continue"])];
    if (extensions) {
        for (const ext of extensions) {
            args.push("-e", ext);
        }
    }

    return new Bridge({ cwd: opts.cwd, command: opts.command, args });
}

const sessionManager = new SessionManager(config, createBridge);
const kernel = new Kernel(config, sessionManager);

const shutdown = () => {
    kernel.stop().then(() => process.exit(0));
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

kernel.start().catch((err) => {
    logger.error("Failed to start", { error: String(err) });
    process.exit(1);
});
