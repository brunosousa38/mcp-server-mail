export interface AppConfig {
    mailToken: string;
    mcpAuthToken: string;
    host: string;
    port: number;
    allowedOrigins: string[];
    rateLimitPerMin: number;
    sendRateLimitPerMin: number;
    trustProxy: number | boolean;
    logLevel: string;
    nodeEnv: string;
}

function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value || value.length === 0) {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
}

function parseTrustProxy(raw: string | undefined): number | boolean {
    if (raw === undefined || raw === "") return 1;
    if (raw === "true") return true;
    if (raw === "false") return false;
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n;
    throw new Error(`Invalid MCP_TRUST_PROXY: ${raw}`);
}

function parseOrigins(raw: string | undefined, nodeEnv: string): string[] {
    if (!raw || raw.trim() === "") return [];
    const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
    if (nodeEnv === "production" && list.includes("*")) {
        throw new Error(
            "MCP_ALLOWED_ORIGINS=* is forbidden in production. List explicit origins instead.",
        );
    }
    return list;
}

export function loadConfig(): AppConfig {
    const nodeEnv = process.env.NODE_ENV ?? "production";

    const mailToken = requireEnv("MAIL_TOKEN");
    const mcpAuthToken = requireEnv("MCP_AUTH_TOKEN");

    if (mcpAuthToken.length < 32) {
        throw new Error(
            "MCP_AUTH_TOKEN must be at least 32 characters. Generate with: openssl rand -hex 32",
        );
    }

    const port = Number(process.env.MCP_HTTP_PORT ?? "3000");
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`Invalid MCP_HTTP_PORT: ${process.env.MCP_HTTP_PORT}`);
    }

    const host = process.env.MCP_HTTP_HOST ?? "0.0.0.0";

    const rateLimitPerMin = Number(process.env.MCP_RATE_LIMIT_PER_MIN ?? "60");
    if (!Number.isFinite(rateLimitPerMin) || rateLimitPerMin <= 0) {
        throw new Error("MCP_RATE_LIMIT_PER_MIN must be a positive number");
    }

    const sendRateLimitPerMin = Number(
        process.env.MCP_SEND_RATE_LIMIT_PER_MIN ?? "5",
    );
    if (!Number.isFinite(sendRateLimitPerMin) || sendRateLimitPerMin <= 0) {
        throw new Error("MCP_SEND_RATE_LIMIT_PER_MIN must be a positive number");
    }

    return {
        mailToken,
        mcpAuthToken,
        host,
        port,
        allowedOrigins: parseOrigins(process.env.MCP_ALLOWED_ORIGINS, nodeEnv),
        rateLimitPerMin,
        sendRateLimitPerMin,
        trustProxy: parseTrustProxy(process.env.MCP_TRUST_PROXY),
        logLevel: process.env.LOG_LEVEL ?? "info",
        nodeEnv,
    };
}
