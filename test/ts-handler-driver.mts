/**
 * Driver de smoke test pour la variante Netlify/TypeScript.
 *
 * Exécuté via `npx tsx test/ts-handler-driver.mts` par test/smoke.mjs, avec
 * les variables d'environnement (MCP_AUTH_TOKEN, IMAP_*, SMTP_*, MAIL_*)
 * pointant sur les faux serveurs IMAP/SMTP.
 *
 * Importe le handler fetch de netlify/functions/mcp.ts, construit des objets
 * Request (mêmes cas que la variante PHP) et imprime les résultats en JSON
 * sur stdout, préfixés par __SMOKE_RESULTS__ (les assertions vivent dans
 * smoke.mjs).
 */

import handler from "../netlify/functions/mcp.js";

const TOKEN = process.env.MCP_AUTH_TOKEN ?? "";

interface CaseResult {
    name: string;
    status: number;
    body: unknown;
}

const results: CaseResult[] = [];
let nextId = 1;

function rpc(method: string, params?: unknown) {
    return {
        jsonrpc: "2.0",
        id: nextId++,
        method,
        ...(params !== undefined ? {params} : {}),
    };
}

function toolCall(tool: string, args: Record<string, unknown>) {
    return rpc("tools/call", {name: tool, arguments: args});
}

async function readBody(res: Response): Promise<unknown> {
    const text = await res.text();
    if (!text) return null;
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}

async function post(
    name: string,
    payload: unknown,
    auth: "header" | "query" | "none" = "header",
): Promise<void> {
    const url =
        "http://127.0.0.1/mcp" +
        (auth === "query" ? `?token=${encodeURIComponent(TOKEN)}` : "");
    const headers: Record<string, string> = {
        // Host est indispensable : le transport du SDK (via @hono/node-server)
        // reconstruit l'URL de la requête à partir de cet en-tête.
        host: "127.0.0.1",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
    };
    if (auth === "header") {
        headers.authorization = `Bearer ${TOKEN}`;
    }
    const req = new Request(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
    });
    const res = await handler(req, {} as never);
    results.push({name, status: res.status, body: await readBody(res)});
}

async function main(): Promise<void> {
    // 1. Sans token -> 401
    await post(
        "unauthorized",
        rpc("initialize", {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: {name: "smoke", version: "1.0.0"},
        }),
        "none",
    );

    // 2. GET -> 405 (transport stateless sans SSE)
    {
        const req = new Request(
            `http://127.0.0.1/mcp?token=${encodeURIComponent(TOKEN)}`,
            {
                method: "GET",
                headers: {
                    host: "127.0.0.1",
                    accept: "application/json, text/event-stream",
                },
            },
        );
        const res = await handler(req, {} as never);
        results.push({
            name: "get-not-allowed",
            status: res.status,
            body: await readBody(res),
        });
    }

    // 3. initialize (token en query string, comme un connecteur claude.ai)
    await post(
        "initialize",
        rpc("initialize", {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: {name: "smoke", version: "1.0.0"},
        }),
        "query",
    );

    // 4. notifications/initialized -> 202
    await post("initialized-notification", {
        jsonrpc: "2.0",
        method: "notifications/initialized",
    });

    // 5. tools/list
    await post("tools-list", rpc("tools/list"));

    // 6. tools/call sur les 6 outils
    await post("list-folders", toolCall("list_folders", {}));
    await post(
        "list-emails",
        toolCall("list_emails", {folder: "INBOX", limit: 20}),
    );
    await post("read-email", toolCall("read_email", {folder: "INBOX", uid: 101}));
    await post(
        "search-emails",
        toolCall("search_emails", {folder: "INBOX", from: "alice"}),
    );
    await post(
        "mark-email",
        toolCall("mark_email", {folder: "INBOX", uid: 101, seen: true}),
    );
    await post(
        "send-email",
        toolCall("send_email", {
            to: "ts-dest@example.net",
            cc: "ts-copie@example.net",
            bcc: "ts-cache@example.net",
            subject: "Réponse : réunion d'été",
            body: "Bonjour,\nCeci est un test d'envoi TS (été, cœur).\n.ligne commençant par un point\nFin.",
            in_reply_to: "<msg-101@example.com>",
        }),
    );

    process.stdout.write("__SMOKE_RESULTS__" + JSON.stringify(results) + "\n");
    process.exit(0);
}

main().catch((err: unknown) => {
    const detail =
        err instanceof Error ? (err.stack ?? err.message) : String(err);
    process.stdout.write(
        "__SMOKE_RESULTS__" +
            JSON.stringify([{name: "fatal", status: 0, body: detail}]) +
            "\n",
    );
    process.exit(1);
});
