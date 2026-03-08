import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { NestAPI, NestPlugin } from "./types.js";
import * as logger from "./logger.js";

/**
 * Scan a directory for plugins and load them.
 *
 * A plugin is:
 *   - A .ts file exporting a default function
 *   - A directory with an index.ts exporting a default function
 *
 * Each plugin's default export receives a NestAPI instance.
 */
export async function loadPlugins(pluginsDir: string, api: NestAPI): Promise<string[]> {
    const dir = resolve(pluginsDir);
    const loaded: string[] = [];

    let entries: string[];
    try {
        entries = await readdir(dir);
    } catch (err: any) {
        if (err.code === "ENOENT") {
            logger.info("Plugins directory not found, skipping", { dir });
            return loaded;
        }
        throw err;
    }

    for (const entry of entries.sort()) {
        const fullPath = join(dir, entry);
        const st = await stat(fullPath);

        let modulePath: string | null = null;

        if (st.isFile() && entry.endsWith(".ts")) {
            modulePath = fullPath;
        } else if (st.isDirectory()) {
            const indexPath = join(fullPath, "index.ts");
            try {
                const indexStat = await stat(indexPath);
                if (indexStat.isFile()) {
                    modulePath = indexPath;
                }
            } catch {
                // No index.ts, skip
            }
        }

        if (!modulePath) continue;

        try {
            const mod = await import(modulePath);
            const pluginFn: NestPlugin = mod.default;

            if (typeof pluginFn !== "function") {
                logger.warn("Plugin has no default export function, skipping", { path: modulePath });
                continue;
            }

            await pluginFn(api);
            const name = entry.replace(/\.ts$/, "");
            loaded.push(name);
            logger.info("Plugin loaded", { name, path: modulePath });
        } catch (err) {
            logger.error("Failed to load plugin", { path: modulePath, error: String(err) });
        }
    }

    return loaded;
}
