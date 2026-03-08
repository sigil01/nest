/**
 * Discord listener plugin for nest.
 *
 * Config section (in config.yaml):
 *   discord:
 *     token: "env:DISCORD_TOKEN"
 *     channels:
 *       "channel_id": "session_name"
 */
import { Client, Intents, MessageAttachment } from "discord.js";
import type { NestAPI, Listener, IncomingMessage, MessageOrigin, Attachment, OutgoingFile } from "../src/types.js";
import { splitMessage } from "../src/chunking.js";

const MAX_ATTACHMENT_SIZE = 25 * 1024 * 1024;

async function downloadAttachment(url: string, maxSize: number): Promise<Buffer | null> {
    try {
        const res = await fetch(url);
        if (!res.ok) return null;
        const buf = Buffer.from(await res.arrayBuffer());
        return buf.length > maxSize ? null : buf;
    } catch {
        return null;
    }
}

class DiscordListener implements Listener {
    readonly name = "discord";
    private client: Client;
    private token: string;
    private messageHandler?: (msg: IncomingMessage) => void;
    private emojiCache = new Map<string, { id: string; animated: boolean }>();

    constructor(token: string) {
        this.token = token;
        this.client = new Client({
            intents: [
                Intents.FLAGS.GUILDS,
                Intents.FLAGS.GUILD_MESSAGES,
                Intents.FLAGS.MESSAGE_CONTENT,
                Intents.FLAGS.DIRECT_MESSAGES,
                Intents.FLAGS.GUILD_EMOJIS_AND_STICKERS,
            ],
        });
    }

    async connect(): Promise<void> {
        this.client.on("messageCreate", async (message) => {
            if (!this.messageHandler || message.author.bot) return;

            const attachments: Attachment[] = [];
            for (const [, att] of message.attachments) {
                if (att.size > MAX_ATTACHMENT_SIZE) continue;
                const contentType = att.contentType ?? "application/octet-stream";
                const data = await downloadAttachment(att.url, MAX_ATTACHMENT_SIZE);
                if (!data) continue;

                const attachment: Attachment = {
                    url: att.url,
                    filename: att.name ?? "attachment",
                    contentType,
                    size: data.length,
                    data,
                };
                if (contentType.startsWith("image/")) {
                    attachment.base64 = data.toString("base64");
                }
                attachments.push(attachment);
            }

            this.messageHandler({
                platform: "discord",
                channel: message.channelId,
                sender: message.author.username,
                text: message.content,
                attachments: attachments.length > 0 ? attachments : undefined,
            });
        });

        this.client.on("emojiCreate", () => this.buildEmojiCache());
        this.client.on("emojiDelete", () => this.buildEmojiCache());
        this.client.on("emojiUpdate", () => this.buildEmojiCache());

        await new Promise<void>((resolve, reject) => {
            this.client.once("ready", () => {
                this.buildEmojiCache();
                resolve();
            });
            this.client.login(this.token).catch(reject);
        });
    }

    async disconnect(): Promise<void> {
        await this.client.destroy();
    }

    onMessage(handler: (msg: IncomingMessage) => void): void {
        this.messageHandler = handler;
    }

    async sendTyping(origin: MessageOrigin): Promise<void> {
        const channel = await this.client.channels.fetch(origin.channel);
        if (!channel?.isText() || !("sendTyping" in channel)) return;
        await (channel as any).sendTyping();
    }

    async send(origin: MessageOrigin, text: string, files?: OutgoingFile[]): Promise<void> {
        const channel = await this.client.channels.fetch(origin.channel);
        if (!channel?.isText() || !("send" in channel)) return;

        const resolvedText = this.resolveEmotes(text);
        const chunks = splitMessage(resolvedText);
        const discordFiles = files?.map((f) => new MessageAttachment(f.data, f.filename));

        for (let i = 0; i < chunks.length; i++) {
            const payload: any = { content: chunks[i] };
            if (i === 0 && discordFiles?.length) payload.files = discordFiles;
            await (channel as any).send(payload);
            if (i < chunks.length - 1) await new Promise((r) => setTimeout(r, 250));
        }
    }

    private resolveEmotes(text: string): string {
        if (this.emojiCache.size === 0) return text;
        return text.replace(/:([a-zA-Z0-9_]+):/g, (match, name: string) => {
            const emoji = this.emojiCache.get(name);
            if (!emoji) return match;
            return emoji.animated ? `<a:${name}:${emoji.id}>` : `<:${name}:${emoji.id}>`;
        });
    }

    private buildEmojiCache(): void {
        this.emojiCache.clear();
        for (const [, guild] of this.client.guilds.cache) {
            for (const [, emoji] of guild.emojis.cache) {
                if (emoji.name) {
                    this.emojiCache.set(emoji.name, { id: emoji.id, animated: emoji.animated ?? false });
                }
            }
        }
    }
}

// ─── Plugin Entry Point ──────────────────────────────────────

export default function (nest: NestAPI): void {
    const config = nest.config.discord as { token: string; channels?: Record<string, string> } | undefined;
    if (!config?.token) {
        nest.log.info("Discord plugin: no token configured, skipping");
        return;
    }

    const listener = new DiscordListener(config.token);
    nest.registerListener(listener);

    // Attach channels to sessions
    if (config.channels) {
        for (const [channelId, sessionName] of Object.entries(config.channels)) {
            nest.sessions.attach(sessionName, listener, {
                platform: "discord",
                channel: channelId,
            });
        }
    } else {
        // Default: attach to default session (all channels go there)
        nest.sessions.attach(nest.sessions.getDefault(), listener, {
            platform: "discord",
            channel: "*",
        });
    }

    nest.log.info("Discord plugin loaded", {
        channels: config.channels ? Object.keys(config.channels).length : "all->default",
    });
}
