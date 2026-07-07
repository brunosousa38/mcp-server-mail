import {ImapFlow, type FetchMessageObject} from "imapflow";
import {simpleParser, type AddressObject} from "mailparser";
import type {AppConfig} from "./config.js";

export interface FolderInfo {
    path: string;
    name: string;
    delimiter: string;
    specialUse?: string;
    messages?: number;
    unseen?: number;
}

export interface EmailSummary {
    uid: number;
    seq: number;
    date: string | null;
    from: string;
    to: string;
    subject: string;
    seen: boolean;
    size: number;
}

export interface EmailAttachmentMeta {
    filename: string;
    contentType: string;
    size: number;
}

export interface EmailDetail {
    uid: number;
    subject: string;
    from: string;
    to: string;
    cc: string;
    date: string | null;
    messageId: string;
    inReplyTo: string;
    text: string;
    attachments: EmailAttachmentMeta[];
}

export interface SearchCriteria {
    from?: string;
    to?: string;
    subject?: string;
    text?: string;
    since?: string;
    before?: string;
    unseen?: boolean;
}

/**
 * Ouvre une connexion IMAP, exécute l'opération, puis ferme systématiquement
 * la connexion (exécution stateless en fonction serverless).
 *
 * encryption "ssl"      → secure: true  (TLS implicite, port 993 typiquement)
 * encryption "starttls" → secure: false (imapflow négocie STARTTLS
 *                          automatiquement si le serveur le propose)
 * encryption "none"     → secure: false
 */
async function withClient<T>(
    config: AppConfig,
    fn: (client: ImapFlow) => Promise<T>,
): Promise<T> {
    const client = new ImapFlow({
        host: config.imap.host,
        port: config.imap.port,
        secure: config.imap.encryption === "ssl",
        auth: {user: config.imap.user, pass: config.imap.password},
        logger: false,
    });
    await client.connect();
    try {
        return await fn(client);
    } finally {
        try {
            await client.logout();
        } catch {
            client.close();
        }
    }
}

/** "Nom <adresse>" à partir des adresses d'enveloppe imapflow. */
function formatEnvelopeAddresses(
    addresses: {name?: string; address?: string}[] | undefined,
): string {
    return (addresses ?? [])
        .map((a) => (a.name ? `${a.name} <${a.address ?? ""}>` : (a.address ?? "")))
        .filter(Boolean)
        .join(", ");
}

/** Texte lisible depuis un champ d'adresses mailparser (objet ou tableau). */
function addressText(addr: AddressObject | AddressObject[] | undefined): string {
    if (!addr) return "";
    return Array.isArray(addr) ? addr.map((a) => a.text).join(", ") : addr.text;
}

function summarize(msg: FetchMessageObject): EmailSummary {
    return {
        uid: msg.uid,
        seq: msg.seq,
        date: msg.envelope?.date
            ? new Date(msg.envelope.date).toISOString()
            : null,
        from: formatEnvelopeAddresses(msg.envelope?.from),
        to: formatEnvelopeAddresses(msg.envelope?.to),
        subject: msg.envelope?.subject ?? "(no subject)",
        seen: msg.flags?.has("\\Seen") ?? false,
        size: msg.size ?? 0,
    };
}

/** Conversion HTML → texte basique (fallback quand l'email n'a pas de partie texte). */
function stripHtml(html: string): string {
    return html
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, "\n")
        .replace(/<[^>]+>/g, "")
        .replace(/&nbsp;/gi, " ")
        .replace(/&amp;/gi, "&")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/g, "'")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

export async function listFolders(config: AppConfig): Promise<FolderInfo[]> {
    return withClient(config, async (client) => {
        const list = await client.list({
            statusQuery: {messages: true, unseen: true},
        });
        return list.map((f) => ({
            path: f.path,
            name: f.name,
            delimiter: f.delimiter,
            specialUse: f.specialUse,
            messages: f.status?.messages,
            unseen: f.status?.unseen,
        }));
    });
}

export async function listEmails(
    config: AppConfig,
    folder = "INBOX",
    limit = 20,
    offset = 0,
): Promise<EmailSummary[]> {
    const cappedLimit = Math.min(Math.max(limit, 1), 100);
    return withClient(config, async (client) => {
        const mailbox = await client.mailboxOpen(folder, {readOnly: true});
        const exists = mailbox.exists;
        const end = exists - offset;
        if (end < 1) return [];
        const start = Math.max(1, end - cappedLimit + 1);

        const messages: EmailSummary[] = [];
        for await (const msg of client.fetch(`${start}:${end}`, {
            uid: true,
            envelope: true,
            flags: true,
            size: true,
        })) {
            messages.push(summarize(msg));
        }
        // Du plus récent au plus ancien.
        return messages.sort((a, b) => b.seq - a.seq);
    });
}

export async function readEmail(
    config: AppConfig,
    folder: string,
    uid: number,
): Promise<EmailDetail> {
    return withClient(config, async (client) => {
        await client.mailboxOpen(folder, {readOnly: true});
        const msg = await client.fetchOne(String(uid), {source: true}, {uid: true});
        if (!msg || !msg.source) {
            throw new Error(
                `Email uid=${uid} not found in folder "${folder}"`,
            );
        }
        const parsed = await simpleParser(msg.source);
        const text =
            parsed.text ?? (parsed.html ? stripHtml(parsed.html) : "");

        return {
            uid,
            subject: parsed.subject ?? "(no subject)",
            from: parsed.from?.text ?? "",
            to: addressText(parsed.to),
            cc: addressText(parsed.cc),
            date: parsed.date ? parsed.date.toISOString() : null,
            messageId: parsed.messageId ?? "",
            inReplyTo: parsed.inReplyTo ?? "",
            text,
            attachments: (parsed.attachments ?? []).map((a) => ({
                filename: a.filename ?? "(unnamed)",
                contentType: a.contentType,
                size: a.size,
            })),
        };
    });
}

export async function searchEmails(
    config: AppConfig,
    folder = "INBOX",
    criteria: SearchCriteria = {},
    limit = 20,
): Promise<EmailSummary[]> {
    const cappedLimit = Math.min(Math.max(limit, 1), 100);
    return withClient(config, async (client) => {
        await client.mailboxOpen(folder, {readOnly: true});

        const query: Record<string, unknown> = {};
        if (criteria.from) query.from = criteria.from;
        if (criteria.to) query.to = criteria.to;
        if (criteria.subject) query.subject = criteria.subject;
        if (criteria.text) query.body = criteria.text;
        if (criteria.since) query.since = new Date(criteria.since);
        if (criteria.before) query.before = new Date(criteria.before);
        if (criteria.unseen) query.seen = false;

        const uids = await client.search(query, {uid: true});
        if (!uids || uids.length === 0) return [];

        // Les UIDs croissent avec l'arrivée des messages : garder les derniers.
        const limitedUids = uids.slice(-cappedLimit);

        const messages: EmailSummary[] = [];
        for await (const msg of client.fetch(
            limitedUids.join(","),
            {uid: true, envelope: true, flags: true, size: true},
            {uid: true},
        )) {
            messages.push(summarize(msg));
        }
        return messages.sort((a, b) => b.uid - a.uid);
    });
}

export async function markEmail(
    config: AppConfig,
    folder: string,
    uid: number,
    seen: boolean,
): Promise<void> {
    await withClient(config, async (client) => {
        await client.mailboxOpen(folder);
        if (seen) {
            await client.messageFlagsAdd(String(uid), ["\\Seen"], {uid: true});
        } else {
            await client.messageFlagsRemove(String(uid), ["\\Seen"], {
                uid: true,
            });
        }
    });
}
