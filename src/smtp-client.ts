import nodemailer from "nodemailer";
import type {AppConfig} from "./config.js";

export interface SendEmailInput {
    to: string;
    subject: string;
    body: string;
    cc?: string;
    bcc?: string;
    inReplyTo?: string;
}

export interface SendEmailResult {
    messageId: string;
    accepted: string[];
    rejected: string[];
    response: string;
}

/**
 * Envoie un email via SMTP. Transport créé et fermé à chaque appel
 * (exécution stateless en fonction serverless).
 *
 * encryption "ssl"      → secure: true (TLS implicite, port 465 typiquement)
 * encryption "starttls" → requireTLS: true (STARTTLS obligatoire, port 587)
 * encryption "none"     → ignoreTLS: true
 */
export async function sendEmail(
    config: AppConfig,
    input: SendEmailInput,
): Promise<SendEmailResult> {
    const {smtp} = config;
    const transporter = nodemailer.createTransport({
        host: smtp.host,
        port: smtp.port,
        secure: smtp.encryption === "ssl",
        requireTLS: smtp.encryption === "starttls",
        ignoreTLS: smtp.encryption === "none",
        auth: {user: smtp.user, pass: smtp.password},
    });

    try {
        const info = await transporter.sendMail({
            from: {name: config.mailFromName, address: config.mailFrom},
            to: input.to,
            cc: input.cc,
            bcc: input.bcc,
            subject: input.subject,
            text: input.body,
            inReplyTo: input.inReplyTo,
            references: input.inReplyTo,
        });

        return {
            messageId: info.messageId,
            accepted: (info.accepted ?? []).map(String),
            rejected: (info.rejected ?? []).map(String),
            response: info.response ?? "",
        };
    } finally {
        transporter.close();
    }
}
