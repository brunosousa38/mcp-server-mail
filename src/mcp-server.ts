import {createHash} from "node:crypto";
import {McpServer} from "@modelcontextprotocol/sdk/server/mcp.js";
import {z} from "zod";
import type {MailClient} from "./mail-client.js";
import {logger} from "./logger.js";
import {TokenBucket} from "./rate-limit.js";

export interface BuildServerDeps {
    mailClient: MailClient;
    sendEmailLimiter: TokenBucket;
}

function hashForAudit(value: string): string {
    return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export function buildServer(deps: BuildServerDeps): McpServer {
    const {mailClient, sendEmailLimiter} = deps;

    const server = new McpServer(
        {
            name: "Infomaniak Mail MCP Server",
            version: "0.1.0",
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

    server.tool(
        "mail_list_mailboxes",
        "List all mailboxes in the Infomaniak account",
        {},
        async () => {
            const mailboxes = await mailClient.listMailboxes();
            return {
                content: [
                    {type: "text", text: JSON.stringify(mailboxes, null, 2)},
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
                    {type: "text", text: JSON.stringify(folders, null, 2)},
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
            offset: z.number().describe("Offset for pagination").default(0),
        },
        async ({folder_id, mailbox_uuid, limit, offset}) => {
            const uuid = mailbox_uuid || mailClient.getMailboxUuid();
            const emails = await mailClient.listEmails(
                uuid,
                folder_id,
                limit,
                offset,
            );
            return {
                content: [
                    {type: "text", text: JSON.stringify(emails, null, 2)},
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
            const email = await mailClient.readEmail(
                uuid,
                folder_id,
                message_id,
            );
            return {
                content: [
                    {type: "text", text: JSON.stringify(email, null, 2)},
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
            if (!sendEmailLimiter.tryConsume()) {
                logger.warn(
                    {tool: "mail_send_email"},
                    "send-email rate limit exceeded",
                );
                throw new Error(
                    "Rate limit exceeded for mail_send_email. Try again shortly.",
                );
            }

            logger.info(
                {
                    tool: "mail_send_email",
                    to_hash: hashForAudit(to),
                    subject_hash: hashForAudit(subject),
                    has_cc: Boolean(cc),
                    has_bcc: Boolean(bcc),
                    body_length: body.length,
                },
                "send_email invoked",
            );

            const result = await mailClient.sendEmail(to, subject, body, cc, bcc);
            return {
                content: [
                    {type: "text", text: JSON.stringify(result, null, 2)},
                ],
            };
        },
    );

    return server;
}
