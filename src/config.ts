import {existsSync, readFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";

export type MailEncryption = "ssl" | "starttls" | "none";

export interface MailAccountConfig {
    host: string;
    port: number;
    user: string;
    password: string;
    encryption: MailEncryption;
}

export interface AppConfig {
    mcpAuthToken: string;
    imap: MailAccountConfig;
    smtp: MailAccountConfig;
    mailFrom: string;
    mailFromName: string;
}

interface RawAccountConfig {
    host?: string;
    port?: number;
    user?: string;
    password?: string;
    encryption?: string;
}

interface RawConfigFile {
    mcpAuthToken?: string;
    imap?: RawAccountConfig;
    smtp?: RawAccountConfig;
    mailFrom?: string;
    mailFromName?: string;
}

/**
 * Cherche config.json dans plusieurs emplacements : le cwd d'une fonction
 * Netlify (Lambda) n'est pas la racine du repo, d'où les candidats multiples.
 * L'absence du fichier n'est pas une erreur (config par variables d'env seules).
 */
function findConfigFilePath(): string | null {
    const candidates: string[] = [];

    if (process.env.LAMBDA_TASK_ROOT) {
        candidates.push(join(process.env.LAMBDA_TASK_ROOT, "config.json"));
    }
    candidates.push(join(process.cwd(), "config.json"));

    try {
        const moduleDir = dirname(fileURLToPath(new URL(import.meta.url)));
        candidates.push(join(moduleDir, "..", "config.json"));
        candidates.push(join(moduleDir, "..", "..", "config.json"));
    } catch {
        // import.meta.url inutilisable dans certains bundlers — on ignore.
    }

    for (const path of candidates) {
        if (existsSync(path)) return path;
    }
    return null;
}

function loadConfigFile(): RawConfigFile {
    const path = findConfigFilePath();
    if (!path) return {};
    try {
        return JSON.parse(readFileSync(path, "utf-8")) as RawConfigFile;
    } catch (err) {
        throw new Error(
            `Impossible de lire/parser ${path}: ${(err as Error).message}`,
        );
    }
}

/** Premier argument non vide (ni undefined ni chaîne vide). */
function coalesce(...values: (string | undefined)[]): string {
    for (const v of values) {
        if (v !== undefined && v !== "") return v;
    }
    return "";
}

function resolvePort(
    envRaw: string | undefined,
    fileValue: number | undefined,
    fallback: number,
): number {
    if (envRaw !== undefined && envRaw !== "") {
        const n = Number(envRaw);
        if (!Number.isInteger(n) || n < 1 || n > 65535) {
            throw new Error(`Port invalide: "${envRaw}"`);
        }
        return n;
    }
    if (fileValue !== undefined) {
        if (!Number.isInteger(fileValue) || fileValue < 1 || fileValue > 65535) {
            throw new Error(`Port invalide dans config.json: ${fileValue}`);
        }
        return fileValue;
    }
    return fallback;
}

function resolveEncryption(
    envRaw: string | undefined,
    fileValue: string | undefined,
    fallback: MailEncryption,
): MailEncryption {
    const raw = coalesce(envRaw, fileValue);
    if (!raw) return fallback;
    const normalized = raw.toLowerCase();
    if (
        normalized === "ssl" ||
        normalized === "starttls" ||
        normalized === "none"
    ) {
        return normalized;
    }
    throw new Error(
        `Valeur d'encryption invalide: "${raw}" (attendu: ssl, starttls ou none)`,
    );
}

export function loadConfig(): AppConfig {
    const file = loadConfigFile();
    const env = process.env;

    const mcpAuthToken = coalesce(env.MCP_AUTH_TOKEN, file.mcpAuthToken);

    const imapHost = coalesce(env.IMAP_HOST, file.imap?.host);
    const imapUser = coalesce(env.IMAP_USER, file.imap?.user);
    const imapPassword = coalesce(env.IMAP_PASSWORD, file.imap?.password);
    const imapPort = resolvePort(env.IMAP_PORT, file.imap?.port, 993);
    const imapEncryption = resolveEncryption(
        env.IMAP_ENCRYPTION,
        file.imap?.encryption,
        "ssl",
    );

    const smtpHost = coalesce(env.SMTP_HOST, file.smtp?.host);
    const smtpUser = coalesce(env.SMTP_USER, file.smtp?.user, imapUser);
    const smtpPassword = coalesce(
        env.SMTP_PASSWORD,
        file.smtp?.password,
        imapPassword,
    );
    const smtpPort = resolvePort(env.SMTP_PORT, file.smtp?.port, 465);
    const smtpEncryption = resolveEncryption(
        env.SMTP_ENCRYPTION,
        file.smtp?.encryption,
        "ssl",
    );

    const mailFrom = coalesce(env.MAIL_FROM, file.mailFrom, imapUser);
    const mailFromName = coalesce(
        env.MAIL_FROM_NAME,
        file.mailFromName,
        mailFrom.split("@")[0],
    );

    if (!mcpAuthToken || mcpAuthToken.length < 32) {
        throw new Error(
            "MCP_AUTH_TOKEN manquant ou trop court (minimum 32 caractères) — générez-le avec: openssl rand -hex 32",
        );
    }
    if (!imapHost) {
        throw new Error(
            "Configuration IMAP incomplète: host manquant (config.json imap.host ou variable IMAP_HOST)",
        );
    }
    if (!imapUser) {
        throw new Error(
            "Configuration IMAP incomplète: user manquant (config.json imap.user ou variable IMAP_USER)",
        );
    }
    if (!imapPassword) {
        throw new Error(
            "Configuration IMAP incomplète: password manquant (config.json imap.password ou variable IMAP_PASSWORD)",
        );
    }
    if (!smtpHost) {
        throw new Error(
            "Configuration SMTP incomplète: host manquant (config.json smtp.host ou variable SMTP_HOST)",
        );
    }

    return {
        mcpAuthToken,
        imap: {
            host: imapHost,
            port: imapPort,
            user: imapUser,
            password: imapPassword,
            encryption: imapEncryption,
        },
        smtp: {
            host: smtpHost,
            port: smtpPort,
            user: smtpUser,
            password: smtpPassword,
            encryption: smtpEncryption,
        },
        mailFrom,
        mailFromName,
    };
}
