#!/usr/bin/env node

import {McpServer} from "@modelcontextprotocol/sdk/server/mcp.js";
import {z} from "zod";
import {StdioServerTransport} from "@modelcontextprotocol/sdk/server/stdio.js";

const token = process.env.MAIL_TOKEN;

if (!token) {
    console.error(
        "Please set MAIL_TOKEN environment variable",
    );
    process.exit(1);
}

const API_BASE = "https://mail.infomaniak.com/api";

class MailClient {
    private readonly headers: { Authorization: string; "Content-Type": string };
    private mailboxUuid: string | null = null;
    private hostingId: number | null = null;
    private mailboxName: string | null = null;
    private fromEmail: string | null = null;
    private fromName: string | null = null;

    constructor() {
        this.headers = {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
        };
    }

    private async apiRequest(path: string, options: RequestInit = {}): Promise<any> {
        const url = `${API_BASE}${path}`;
        const response = await fetch(url, {
            ...options,
            headers: {
                ...this.headers,
                ...(options.headers as Record<string, string> || {}),
            },
        });

        if (!response.ok) {
            const text = await response.text();
            throw new Error(
                `API request failed: ${response.status} ${response.statusText}\n${text}`,
            );
        }

        return response.json();
    }

    async init(): Promise<void> {
        const mailboxesResponse = await this.apiRequest(
            "/mailbox?with=aliases,permissions,accountId,count_users",
        );
        if (
            mailboxesResponse.result !== "success" ||
            !mailboxesResponse.data?.length
        ) {
            throw new Error("No mailboxes found. Check your MAIL_TOKEN.");
        }

        const mailbox = mailboxesResponse.data[0];
        this.mailboxUuid = mailbox.uuid;
        this.hostingId = mailbox.hosting_id;
        this.mailboxName = mailbox.mailbox;
        this.fromEmail = mailbox.email;
        this.fromName = mailbox.email.split("@")[0];
    }

    getMailboxUuid(): string {
        if (!this.mailboxUuid) throw new Error("Mailbox not initialized");
        return this.mailboxUuid;
    }

    async listMailboxes(): Promise<any[]> {
        const response = await this.apiRequest(
            "/mailbox?with=aliases,permissions,accountId,count_users",
        );
        return (response.data || []).map((m: any) => ({
            uuid: m.uuid,
            email: m.email,
            mailbox: m.mailbox,
            is_primary: m.is_primary,
            hosting_id: m.hosting_id,
        }));
    }

    async listFolders(mailboxUuid: string): Promise<any[]> {
        const response = await this.apiRequest(
            `/mail/${mailboxUuid}/folder?with=ik-static`,
        );

        const flatten = (folders: any[], prefix = ""): any[] => {
            const result: any[] = [];
            for (const folder of folders || []) {
                const fullPath = prefix
                    ? `${prefix}${folder.separator}${folder.name}`
                    : folder.name;
                result.push({
                    id: folder.id,
                    name: folder.name,
                    path: fullPath,
                    role: folder.role,
                    unread_count: folder.unread_count,
                    total_count: folder.total_count,
                });
                if (folder.children?.length) {
                    result.push(...flatten(folder.children, fullPath));
                }
            }
            return result;
        };

        return flatten(response.data || []);
    }

    async listEmails(
        mailboxUuid: string,
        folderId: string,
        limit: number = 50,
        offset: number = 0,
    ): Promise<any[]> {
        const response = await this.apiRequest(
            `/mail/${mailboxUuid}/folder/${folderId}/message?offset=${offset}&thread=on&severywhere=0&limit=${limit}`,
        );

        return (response.data?.threads || []).map((thread: any) => ({
            thread_uid: thread.uid,
            subject: thread.subject || "(no subject)",
            from: thread.from?.map((f: any) => `${f.name} <${f.email}>`).join(", ") || "",
            date: thread.date,
            messages_count: thread.messages_count,
            unseen_messages: thread.unseen_messages,
            preview: thread.messages?.[0]?.preview || "",
            first_message_uid: thread.messages?.[0]?.uid || null,
        }));
    }

    async readEmail(
        mailboxUuid: string,
        folderId: string,
        messageId: string,
    ): Promise<any> {
        const response = await this.apiRequest(
            `/mail/${mailboxUuid}/folder/${folderId}/message/${messageId}?prefered_format=html&with=auto_uncrypt,thread_context`,
        );

        const data = response.data;
        return {
            uid: data.uid,
            msg_id: data.msg_id,
            subject: data.subject || "(no subject)",
            from: data.from?.map((f: any) => `${f.name} <${f.email}>`).join(", ") || "",
            to: data.to?.map((t: any) => `${t.name} <${t.email}>`).join(", ") || "",
            cc: data.cc?.map((c: any) => `${c.name} <${c.email}>`).join(", ") || "",
            bcc: data.bcc?.map((b: any) => `${b.name} <${b.email}>`).join(", ") || "",
            date: data.date,
            body: data.body,
            html: data.html,
            preview: data.preview,
            has_attachments: data.has_attachments,
            seen: data.seen,
            flagged: data.flagged,
            folder: data.folder,
            headers: data.headers,
        };
    }

    async sendEmail(
        to: string,
        subject: string,
        body: string,
        cc?: string,
        bcc?: string,
    ): Promise<any> {
        if (!this.mailboxUuid) throw new Error("Mailbox not initialized");

        const toRecipients = to.split(",").map((email) => ({
            name: "",
            email: email.trim(),
        }));
        const ccRecipients = cc
            ? cc.split(",").map((email) => ({name: "", email: email.trim()}))
            : null;
        const bccRecipients = bcc
            ? bcc.split(",").map((email) => ({name: "", email: email.trim()}))
            : null;

        const htmlBody = `<html><body><div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; font-size: 14px;">${body.replace(/\n/g, "<br>")}</div></body></html>`;

        const draftPayload = {
            uuid: null,
            subject,
            body: htmlBody,
            quote: null,
            mime_type: "text/html",
            from: {
                id: null,
                name: this.fromName,
                email: this.fromEmail,
            },
            reply_to: {
                name: this.fromName,
                email: this.fromEmail,
            },
            to: toRecipients,
            cc: ccRecipients,
            bcc: bccRecipients,
            references: "",
            in_reply_to: null,
            in_reply_to_uid: null,
            forwarded_uid: null,
            attachments: [],
            identity_id: null,
            ack_request: false,
            st_uuid: null,
            uid: null,
            resource: null,
            priority: "normal",
            encrypted: false,
            encryption_password: "",
            event_poll_uuid: null,
            action: "save",
            delay: 0,
        };

        const draftResponse = await this.apiRequest(
            `/mail/${this.mailboxUuid}/draft`,
            {
                method: "POST",
                body: JSON.stringify(draftPayload),
            },
        );

        if (draftResponse.result !== "success") {
            throw new Error(
                `Failed to create draft: ${JSON.stringify(draftResponse)}`,
            );
        }

        const draftUuid = draftResponse.data.uuid;
        const draftUid = draftResponse.data.uid;

        const sendPayload = {
            ...draftPayload,
            uuid: draftUuid,
            uid: draftUid,
            resource: `/api/mail/${this.mailboxUuid}/draft/${draftUuid}`,
            action: "send",
        };

        const sendResponse = await this.apiRequest(
            `/mail/${this.mailboxUuid}/draft/${draftUuid}`,
            {
                method: "PUT",
                body: JSON.stringify(sendPayload),
            },
        );

        if (sendResponse.result !== "success") {
            throw new Error(
                `Failed to send email: ${JSON.stringify(sendResponse)}`,
            );
        }

        return sendResponse.data;
    }
}

const server = new McpServer(
    {
        name: "Infomaniak Mail MCP Server",
        version: "0.0.1",
    },
    {
        capabilities: {
            completions: {},
            prompts: {},
            resources: {},
            tools: {},
        },
    },
);

const mailClient = new MailClient();

server.tool(
    "mail_list_mailboxes",
    "List all mailboxes in the Infomaniak account",
    {},
    async () => {
        const mailboxes = await mailClient.listMailboxes();
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify(mailboxes, null, 2),
                },
            ],
        };
    },
);

server.tool(
    "mail_list_folders",
    "List all folders in a mailbox",
    {
        mailbox_uuid: z
            .string()
            .describe("Mailbox UUID (optional, uses primary if omitted)")
            .optional(),
    },
    async ({mailbox_uuid}) => {
        const uuid = mailbox_uuid || mailClient.getMailboxUuid();
        const folders = await mailClient.listFolders(uuid);
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify(folders, null, 2),
                },
            ],
        };
    },
);

server.tool(
    "mail_list_emails",
    "List emails in a folder",
    {
        folder_id: z.string().describe("Folder ID (e.g., INBOX folder id)"),
        mailbox_uuid: z
            .string()
            .describe("Mailbox UUID (optional, uses primary if omitted)")
            .optional(),
        limit: z
            .number()
            .describe("Maximum number of emails to return")
            .default(50),
        offset: z
            .number()
            .describe("Offset for pagination")
            .default(0),
    },
    async ({folder_id, mailbox_uuid, limit, offset}) => {
        const uuid = mailbox_uuid || mailClient.getMailboxUuid();
        const emails = await mailClient.listEmails(uuid, folder_id, limit, offset);
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify(emails, null, 2),
                },
            ],
        };
    },
);

server.tool(
    "mail_read_email",
    "Read a specific email",
    {
        folder_id: z.string().describe("Folder ID containing the email"),
        message_id: z.string().describe("Message ID or UID"),
        mailbox_uuid: z
            .string()
            .describe("Mailbox UUID (optional, uses primary if omitted)")
            .optional(),
    },
    async ({folder_id, message_id, mailbox_uuid}) => {
        const uuid = mailbox_uuid || mailClient.getMailboxUuid();
        const email = await mailClient.readEmail(uuid, folder_id, message_id);
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify(email, null, 2),
                },
            ],
        };
    },
);

server.tool(
    "mail_send_email",
    "Send an email",
    {
        to: z
            .string()
            .describe("Recipient email address(es), comma-separated"),
        subject: z.string().describe("Email subject"),
        body: z.string().describe("Email body (plain text)"),
        cc: z
            .string()
            .describe("CC recipient(s), comma-separated")
            .optional(),
        bcc: z
            .string()
            .describe("BCC recipient(s), comma-separated")
            .optional(),
    },
    async ({to, subject, body, cc, bcc}) => {
        const result = await mailClient.sendEmail(to, subject, body, cc, bcc);
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify(result, null, 2),
                },
            ],
        };
    },
);

async function main() {
    await mailClient.init();
    const transport = new StdioServerTransport();
    await server.connect(transport);
}

main().catch((error) => {
    console.error("Fatal error in main():", error);
    process.exit(1);
});
