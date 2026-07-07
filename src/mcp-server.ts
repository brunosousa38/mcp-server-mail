import {McpServer} from "@modelcontextprotocol/sdk/server/mcp.js";
import {z} from "zod";
import type {AppConfig} from "./config.js";
import {
    listEmails,
    listFolders,
    markEmail,
    readEmail,
    searchEmails,
} from "./imap-client.js";
import {sendEmail} from "./smtp-client.js";

function textResult(value: unknown) {
    return {
        content: [
            {type: "text" as const, text: JSON.stringify(value, null, 2)},
        ],
    };
}

function errorResult(err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
        content: [{type: "text" as const, text: `Error: ${message}`}],
        isError: true as const,
    };
}

export function buildServer(config: AppConfig): McpServer {
    const server = new McpServer(
        {
            name: "Mail MCP Server (IMAP/SMTP)",
            version: "1.0.0",
        },
        {
            capabilities: {
                tools: {},
            },
        },
    );

    server.tool(
        "list_folders",
        "List all folders of the mail account with message and unseen counts. Useful to discover exact folder paths before listing or searching emails.",
        {},
        async () => {
            try {
                return textResult(await listFolders(config));
            } catch (err) {
                return errorResult(err);
            }
        },
    );

    server.tool(
        "list_emails",
        "List recent emails in a folder, most recent first, with summary metadata (uid, from, to, subject, date, read status, size). Use read_email with the uid to get the full body.",
        {
            folder: z
                .string()
                .describe('Folder path, e.g. "INBOX" (default) or "Sent"')
                .optional(),
            limit: z
                .number()
                .int()
                .min(1)
                .max(100)
                .describe("Maximum number of emails to return (default 20, max 100)")
                .optional(),
            offset: z
                .number()
                .int()
                .min(0)
                .describe(
                    "Number of most recent emails to skip, for pagination (default 0)",
                )
                .optional(),
        },
        async ({folder, limit, offset}) => {
            try {
                return textResult(
                    await listEmails(
                        config,
                        folder ?? "INBOX",
                        limit ?? 20,
                        offset ?? 0,
                    ),
                );
            } catch (err) {
                return errorResult(err);
            }
        },
    );

    server.tool(
        "read_email",
        "Read the full content of one email by UID: subject, sender, recipients, date, Message-ID, plain text body, and attachment metadata (names and sizes only, no attachment content).",
        {
            folder: z
                .string()
                .describe('Folder path (default "INBOX")')
                .optional(),
            uid: z
                .number()
                .int()
                .positive()
                .describe("Email UID, as returned by list_emails or search_emails"),
        },
        async ({folder, uid}) => {
            try {
                return textResult(
                    await readEmail(config, folder ?? "INBOX", uid),
                );
            } catch (err) {
                return errorResult(err);
            }
        },
    );

    server.tool(
        "search_emails",
        "Search emails in a folder by sender, recipient, subject, body text, date range and/or unread status. Returns the same summary format as list_emails.",
        {
            folder: z
                .string()
                .describe('Folder path (default "INBOX")')
                .optional(),
            from: z.string().describe("Filter by sender").optional(),
            to: z.string().describe("Filter by recipient").optional(),
            subject: z
                .string()
                .describe("Filter by subject substring")
                .optional(),
            text: z
                .string()
                .describe("Filter by text contained in the body")
                .optional(),
            since: z
                .string()
                .date()
                .describe("Only emails on or after this date (YYYY-MM-DD)")
                .optional(),
            before: z
                .string()
                .date()
                .describe("Only emails before this date (YYYY-MM-DD)")
                .optional(),
            unseen: z
                .boolean()
                .describe("Only return unread emails")
                .optional(),
            limit: z
                .number()
                .int()
                .min(1)
                .max(100)
                .describe("Maximum number of results (default 20, max 100)")
                .optional(),
        },
        async ({folder, from, to, subject, text, since, before, unseen, limit}) => {
            try {
                return textResult(
                    await searchEmails(
                        config,
                        folder ?? "INBOX",
                        {from, to, subject, text, since, before, unseen},
                        limit ?? 20,
                    ),
                );
            } catch (err) {
                return errorResult(err);
            }
        },
    );

    server.tool(
        "send_email",
        "Send an email via SMTP. Provide body (plain text) and/or html for an HTML message; at least one is required. Optionally attach files via attachments. To reply within an existing thread, pass in_reply_to with the Message-ID of the original email (see read_email output).",
        {
            to: z
                .string()
                .describe("Recipient email address(es), comma-separated"),
            subject: z.string().describe("Email subject"),
            body: z
                .string()
                .describe(
                    "Plain-text body. Optional if html is provided; sent as the text/plain part.",
                )
                .optional(),
            html: z
                .string()
                .describe(
                    "HTML body. Optional if body is provided. When both are given, they are sent as multipart/alternative.",
                )
                .optional(),
            cc: z
                .string()
                .describe("CC recipient(s), comma-separated")
                .optional(),
            bcc: z
                .string()
                .describe("BCC recipient(s), comma-separated")
                .optional(),
            in_reply_to: z
                .string()
                .describe(
                    "Message-ID of the email being replied to, to keep the thread",
                )
                .optional(),
            attachments: z
                .array(
                    z.object({
                        filename: z
                            .string()
                            .describe("File name shown to the recipient"),
                        content: z
                            .string()
                            .describe("File content, Base64-encoded"),
                        content_type: z
                            .string()
                            .describe(
                                'MIME type, e.g. "application/pdf" (default: application/octet-stream)',
                            )
                            .optional(),
                    }),
                )
                .describe("Files to attach to the email")
                .optional(),
        },
        async ({to, subject, body, html, cc, bcc, in_reply_to, attachments}) => {
            try {
                if (!body?.trim() && !html?.trim()) {
                    throw new Error(
                        "Provide at least one of 'body' (plain text) or 'html'.",
                    );
                }
                return textResult(
                    await sendEmail(config, {
                        to,
                        subject,
                        body,
                        html,
                        cc,
                        bcc,
                        inReplyTo: in_reply_to,
                        attachments: attachments?.map((a) => ({
                            filename: a.filename,
                            content: a.content,
                            contentType: a.content_type,
                        })),
                    }),
                );
            } catch (err) {
                return errorResult(err);
            }
        },
    );

    server.tool(
        "mark_email",
        "Mark an email as read or unread.",
        {
            folder: z
                .string()
                .describe('Folder path (default "INBOX")')
                .optional(),
            uid: z.number().int().positive().describe("Email UID"),
            seen: z
                .boolean()
                .describe("true to mark as read, false to mark as unread"),
        },
        async ({folder, uid, seen}) => {
            try {
                await markEmail(config, folder ?? "INBOX", uid, seen);
                return textResult({ok: true, uid, seen});
            } catch (err) {
                return errorResult(err);
            }
        },
    );

    return server;
}
