/**
 * Matrix listener plugin for nest.
 *
 * Config section:
 *   matrix:
 *     homeserver: "https://matrix.example.org"
 *     user: "@bot:example.org"
 *     token: "env:MATRIX_TOKEN"
 *     storage_path: "./matrix-bot.json"
 *     channels:
 *       "!room:example.org": "session_name"
 */
import { MatrixClient, SimpleFsStorageProvider } from "matrix-bot-sdk";
import type { NestAPI, Listener, IncomingMessage, MessageOrigin, OutgoingFile } from "../src/types.js";

class MatrixListener implements Listener {
    readonly name = "matrix";
    private client: MatrixClient;
    private userId: string;
    private messageHandler?: (msg: IncomingMessage) => void;

    constructor(homeserver: string, user: string, token: string, storagePath = "matrix-bot.json") {
        this.userId = user;
        const storage = new SimpleFsStorageProvider(storagePath);
        this.client = new MatrixClient(homeserver, token, storage);
    }

    async connect(): Promise<void> {
        this.client.on("room.message", async (roomId: string, event: any) => {
            if (!this.messageHandler) return;
            if (event.type !== "m.room.message") return;
            if (event.content?.msgtype !== "m.text") return;
            if (event.sender === this.userId) return;

            this.messageHandler({
                platform: "matrix",
                channel: roomId,
                sender: event.sender,
                text: event.content.body,
            });
        });
        await this.client.start();
    }

    async disconnect(): Promise<void> {
        await this.client.stop();
    }

    onMessage(handler: (msg: IncomingMessage) => void): void {
        this.messageHandler = handler;
    }

    async sendTyping(origin: MessageOrigin): Promise<void> {
        await this.client.setTyping(origin.channel, true, 15_000);
    }

    async send(origin: MessageOrigin, text: string, _files?: OutgoingFile[]): Promise<void> {
        await this.client.sendText(origin.channel, text);
    }
}

// ─── Plugin Entry Point ──────────────────────────────────────

export default function (nest: NestAPI): void {
    const config = nest.config.matrix as {
        homeserver: string;
        user: string;
        token: string;
        storage_path?: string;
        channels?: Record<string, string>;
    } | undefined;

    if (!config?.token) {
        nest.log.info("Matrix plugin: no token configured, skipping");
        return;
    }

    const listener = new MatrixListener(
        config.homeserver,
        config.user,
        config.token,
        config.storage_path,
    );
    nest.registerListener(listener);

    if (config.channels) {
        for (const [roomId, sessionName] of Object.entries(config.channels)) {
            nest.sessions.attach(sessionName, listener, {
                platform: "matrix",
                channel: roomId,
            });
        }
    } else {
        nest.sessions.attach(nest.sessions.getDefault(), listener, {
            platform: "matrix",
            channel: "*",
        });
    }

    nest.log.info("Matrix plugin loaded");
}
