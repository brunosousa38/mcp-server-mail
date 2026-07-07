import nodemailer from "nodemailer";
import type {AppConfig} from "./config.js";

export interface SendEmailAttachment {
    filename: string;
    /** Contenu binaire encodé en base64. */
    content: string;
    contentType?: string;
}

export interface SendEmailInput {
    to: string;
    subject: string;
    /** Corps en texte brut. Optionnel si `html` est fourni. */
    body?: string;
    /** Corps HTML. Optionnel si `body` est fourni. */
    html?: string;
    cc?: string;
    bcc?: string;
    inReplyTo?: string;
    attachments?: SendEmailAttachment[];
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
 *
 * Corps : `body` (texte), `html`, ou les deux (nodemailer produit alors un
 * multipart/alternative). Avec des pièces jointes, l'ensemble est encapsulé
 * dans un multipart/mixed. Au moins un des deux corps est requis.
 */
export async function sendEmail(
    config: AppConfig,
    input: SendEmailInput,
): Promise<SendEmailResult> {
    const text = input.body?.trim() ? input.body : undefined;
    const html = input.html?.trim() ? input.html : undefined;
    if (!text && !html) {
        throw new Error(
            "Le corps du message est vide : fournissez 'body' (texte) et/ou 'html'.",
        );
    }

    const attachments = input.attachments?.map((a) => ({
        filename: a.filename,
        content: Buffer.from(a.content, "base64"),
        contentType: a.contentType,
    }));

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
            text,
            html,
            inReplyTo: input.inReplyTo,
            references: input.inReplyTo,
            attachments,
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
