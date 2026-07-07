/**
 * Smoke tests de bout en bout des deux variantes du serveur MCP Mail,
 * contre les faux serveurs IMAP/SMTP de test/ (aucune dépendance externe).
 *
 *  - Variante PHP  : php -S + php-ovh/config.local.php temporaire ;
 *  - Variante TS   : handler Netlify importé via `npx tsx` (sous-processus).
 *
 * Usage : npm run test:smoke   (ou : node test/smoke.mjs)
 * Sortie : une ligne PASS/FAIL par assertion, code retour != 0 si échec.
 */

import {spawn} from "node:child_process";
import {existsSync, unlinkSync, writeFileSync} from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {
    startFakeImapServer,
    SUBJECT_101_DECODED,
    BODY_101_MARKERS,
    ATTACHMENT_101,
} from "./fake-imap-server.mjs";
import {startFakeSmtpServer} from "./fake-smtp-server.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN = "0123456789abcdef".repeat(4); // 64 caractères
const PHP_CONFIG_PATH = path.join(ROOT, "php-ovh", "config.local.php");

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

const checks = [];

function check(name, cond, details = "") {
    const ok = !!cond;
    checks.push({name, ok, details});
    const suffix = ok || details === "" ? "" : `  -- ${truncate(details)}`;
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${suffix}`);
}

function truncate(s) {
    s = typeof s === "string" ? s : JSON.stringify(s);
    return s.length > 300 ? s.slice(0, 300) + "…" : s;
}

// ---------------------------------------------------------------------------
// Utilitaires
// ---------------------------------------------------------------------------

let rpcId = 0;

function rpc(method, params) {
    return {
        jsonrpc: "2.0",
        id: ++rpcId,
        method,
        ...(params !== undefined ? {params} : {}),
    };
}

function toolCall(tool, args) {
    return rpc("tools/call", {name: tool, arguments: args});
}

/** Extrait le JSON embarqué dans result.content[0].text d'un tools/call. */
function toolResult(body) {
    const content = body?.result?.content;
    if (!Array.isArray(content) || content[0]?.type !== "text") return null;
    try {
        return JSON.parse(content[0].text);
    } catch {
        return null;
    }
}

function isToolError(body) {
    return body?.result?.isError === true;
}

/** Environnement débarrassé de toute conf mail héritée du shell appelant. */
function cleanEnv() {
    const env = {...process.env};
    for (const key of Object.keys(env)) {
        if (/^(MCP_AUTH_TOKEN|IMAP_|SMTP_|MAIL_FROM)/.test(key)) {
            delete env[key];
        }
    }
    return env;
}

function decodeQuotedPrintable(s) {
    return Buffer.from(
        s
            .replace(/=\r?\n/g, "") // soft line breaks
            .replace(/=([0-9A-Fa-f]{2})/g, (_, h) =>
                String.fromCharCode(parseInt(h, 16)),
            ),
        "latin1",
    ).toString("utf8");
}

/** Décode les encoded-words RFC 2047 (B/Q, UTF-8) d'une valeur d'en-tête. */
function decodeRfc2047(value) {
    // Les espaces entre deux encoded-words consécutifs sont ignorés.
    value = value.replace(/(\?=)\s+(=\?)/g, "$1$2");
    return value.replace(
        /=\?utf-8\?([bq])\?([^?]*)\?=/gi,
        (_, enc, payload) => {
            if (enc.toLowerCase() === "b") {
                return Buffer.from(payload, "base64").toString("utf8");
            }
            return decodeQuotedPrintable(payload.replace(/_/g, " "));
        },
    );
}

/** Analyse le DATA SMTP : en-têtes (dépliés) + corps décodé. */
function parseSmtpData(data) {
    const sepIdx = data.indexOf("\r\n\r\n");
    const rawHeaders = sepIdx === -1 ? data : data.slice(0, sepIdx);
    const rawBody = sepIdx === -1 ? "" : data.slice(sepIdx + 4);
    const unfolded = rawHeaders.replace(/\r\n[ \t]+/g, " ");
    const headers = {};
    for (const line of unfolded.split("\r\n")) {
        const pos = line.indexOf(":");
        if (pos > 0) {
            headers[line.slice(0, pos).trim().toLowerCase()] = line
                .slice(pos + 1)
                .trim();
        }
    }
    const cte = (headers["content-transfer-encoding"] ?? "").toLowerCase();
    let body = rawBody;
    if (cte === "quoted-printable") {
        body = decodeQuotedPrintable(rawBody);
    } else if (cte === "base64") {
        body = Buffer.from(rawBody, "base64").toString("utf8");
    }
    return {headers, body};
}

/** Assertions communes sur un message reçu par le fake SMTP. */
function checkSmtpMessage(prefix, msg, expected) {
    check(`${prefix}: enveloppe MAIL FROM`, msg?.from === expected.from, msg?.from);
    check(
        `${prefix}: enveloppe RCPT TO (to+cc+bcc)`,
        expected.rcpt.every((r) => msg?.rcpt?.includes(r)) &&
            msg?.rcpt?.length === expected.rcpt.length,
        JSON.stringify(msg?.rcpt),
    );
    if (!msg) return;
    const {headers, body} = parseSmtpData(msg.data);
    check(
        `${prefix}: en-tête To`,
        (headers.to ?? "").includes(expected.to),
        headers.to,
    );
    check(
        `${prefix}: en-tête Subject encodé RFC 2047`,
        /=\?utf-8\?/i.test(headers.subject ?? ""),
        headers.subject,
    );
    check(
        `${prefix}: Subject décodé correct`,
        decodeRfc2047(headers.subject ?? "") === expected.subject,
        decodeRfc2047(headers.subject ?? ""),
    );
    check(
        `${prefix}: pas d'en-tête Bcc`,
        headers.bcc === undefined,
        headers.bcc,
    );
    check(
        `${prefix}: In-Reply-To présent`,
        (headers["in-reply-to"] ?? "").includes(expected.inReplyTo),
        headers["in-reply-to"],
    );
    const bodyOk = expected.bodyMarkers.every((m) => body.includes(m));
    check(`${prefix}: corps décodable (accents corrects)`, bodyOk, body);
}

function waitForExit(child) {
    return new Promise((resolve) => {
        child.on("exit", (code) => resolve(code));
        child.on("error", () => resolve(-1));
    });
}

async function waitForHttp(url, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        try {
            await fetch(url, {method: "GET"});
            return;
        } catch {
            if (Date.now() > deadline) {
                throw new Error(`Serveur HTTP injoignable : ${url}`);
            }
            await new Promise((r) => setTimeout(r, 100));
        }
    }
}

// ---------------------------------------------------------------------------
// Variante PHP
// ---------------------------------------------------------------------------

async function runPhpSuite(imapPort, smtpPort, smtpMessages) {
    if (existsSync(PHP_CONFIG_PATH)) {
        throw new Error(
            `${PHP_CONFIG_PATH} existe déjà : abandon pour ne pas écraser une configuration réelle.`,
        );
    }

    writeFileSync(
        PHP_CONFIG_PATH,
        `<?php
// Fichier TEMPORAIRE écrit par test/smoke.mjs — supprimé en fin de test.
return [
    'mcp_auth_token' => '${TOKEN}',
    'imap' => [
        'host' => '127.0.0.1',
        'port' => ${imapPort},
        'user' => 'test@example.com',
        'password' => 'testpass',
        'encryption' => 'none',
    ],
    'smtp' => [
        'host' => '127.0.0.1',
        'port' => ${smtpPort},
        'user' => 'test@example.com',
        'password' => 'testpass',
        'encryption' => 'none',
    ],
    'mail_from' => 'test@example.com',
    'mail_from_name' => 'Test Sender',
];
`,
    );

    const phpPort = 8091 + Math.floor(Math.random() * 500);
    const php = spawn(
        "php",
        ["-S", `127.0.0.1:${phpPort}`, "-t", "php-ovh"],
        {cwd: ROOT, env: cleanEnv(), stdio: ["ignore", "ignore", "pipe"]},
    );
    let phpStderr = "";
    php.stderr.on("data", (d) => {
        phpStderr += d.toString();
    });

    const base = `http://127.0.0.1:${phpPort}/mcp.php`;

    try {
        await waitForHttp(base);

        const post = (payload, auth = "header") =>
            fetch(base + (auth === "query" ? `?token=${TOKEN}` : ""), {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    ...(auth === "header"
                        ? {authorization: `Bearer ${TOKEN}`}
                        : {}),
                },
                body: JSON.stringify(payload),
            });

        // --- 401 sans token -------------------------------------------------
        let res = await post(rpc("initialize", {}), "none");
        check("php: 401 sans token", res.status === 401, `status=${res.status}`);

        // --- GET -> 405 -----------------------------------------------------
        res = await fetch(`${base}?token=${TOKEN}`, {method: "GET"});
        check("php: GET -> 405", res.status === 405, `status=${res.status}`);

        // --- initialize (token en query) -------------------------------------
        res = await post(
            rpc("initialize", {
                protocolVersion: "2025-06-18",
                capabilities: {},
                clientInfo: {name: "smoke", version: "1.0.0"},
            }),
            "query",
        );
        let body = await res.json();
        check(
            "php: initialize -> protocolVersion 2025-06-18",
            res.status === 200 &&
                body?.result?.protocolVersion === "2025-06-18",
            JSON.stringify(body),
        );

        // --- notifications/initialized -> 202 --------------------------------
        res = await post({jsonrpc: "2.0", method: "notifications/initialized"});
        check(
            "php: notifications/initialized -> 202",
            res.status === 202,
            `status=${res.status}`,
        );

        // --- tools/list -> 6 outils -------------------------------------------
        res = await post(rpc("tools/list"));
        body = await res.json();
        const tools = (body?.result?.tools ?? []).map((t) => t.name).sort();
        check(
            "php: tools/list -> 6 outils",
            JSON.stringify(tools) ===
                JSON.stringify([
                    "list_emails",
                    "list_folders",
                    "mark_email",
                    "read_email",
                    "search_emails",
                    "send_email",
                ]),
            JSON.stringify(tools),
        );

        // --- list_folders ------------------------------------------------------
        res = await post(toolCall("list_folders", {}));
        body = await res.json();
        let data = toolResult(body);
        const folderPaths = (data?.folders ?? []).map((f) => f.path);
        check(
            "php: list_folders contient INBOX et Archive",
            !isToolError(body) &&
                folderPaths.includes("INBOX") &&
                folderPaths.includes("Archive"),
            JSON.stringify(body),
        );
        const inbox = (data?.folders ?? []).find((f) => f.path === "INBOX");
        check(
            "php: list_folders INBOX -> 3 messages",
            inbox?.messages === 3,
            JSON.stringify(inbox),
        );

        // --- list_emails ---------------------------------------------------------
        res = await post(toolCall("list_emails", {folder: "INBOX", limit: 20}));
        body = await res.json();
        data = toolResult(body);
        const uids = (data?.emails ?? []).map((e) => e.uid);
        check(
            "php: list_emails -> 3 messages, uid 103..101 (récent d'abord)",
            !isToolError(body) &&
                data?.count === 3 &&
                JSON.stringify(uids) === JSON.stringify([103, 102, 101]),
            JSON.stringify(body),
        );
        const mail101 = (data?.emails ?? []).find((e) => e.uid === 101);
        check(
            "php: list_emails sujet RFC 2047 décodé",
            mail101?.subject === SUBJECT_101_DECODED,
            JSON.stringify(mail101),
        );
        const mail102 = (data?.emails ?? []).find((e) => e.uid === 102);
        check(
            "php: list_emails flag \\Seen reflété",
            mail102?.seen === true && mail101?.seen === false,
            JSON.stringify([mail101, mail102]),
        );

        // --- read_email ------------------------------------------------------------
        res = await post(toolCall("read_email", {folder: "INBOX", uid: 101}));
        body = await res.json();
        data = toolResult(body);
        check(
            "php: read_email texte décodé (accents corrects)",
            !isToolError(body) &&
                BODY_101_MARKERS.every((m) => (data?.text ?? "").includes(m)),
            JSON.stringify(data?.text ?? body),
        );
        check(
            "php: read_email pièce jointe listée",
            (data?.attachments ?? []).some(
                (a) =>
                    a.filename === ATTACHMENT_101 &&
                    a.content_type === "application/pdf",
            ),
            JSON.stringify(data?.attachments),
        );
        check(
            "php: read_email sujet + message_id",
            data?.subject === SUBJECT_101_DECODED &&
                data?.message_id === "<msg-101@example.com>",
            JSON.stringify({subject: data?.subject, id: data?.message_id}),
        );

        // --- search_emails ------------------------------------------------------------
        res = await post(
            toolCall("search_emails", {folder: "INBOX", from: "alice"}),
        );
        body = await res.json();
        data = toolResult(body);
        const searchUids = (data?.emails ?? []).map((e) => e.uid).sort();
        check(
            "php: search_emails -> 2 résultats (uid 101 et 103)",
            !isToolError(body) &&
                data?.count === 2 &&
                JSON.stringify(searchUids) === JSON.stringify([101, 103]),
            JSON.stringify(body),
        );

        // --- mark_email ------------------------------------------------------------
        res = await post(
            toolCall("mark_email", {folder: "INBOX", uid: 101, seen: true}),
        );
        body = await res.json();
        data = toolResult(body);
        check(
            "php: mark_email -> ok",
            !isToolError(body) &&
                data?.status === "ok" &&
                data?.uid === 101 &&
                data?.seen === true,
            JSON.stringify(body),
        );

        // --- send_email ------------------------------------------------------------
        const smtpBefore = smtpMessages.length;
        const phpSubject = "Réponse : réunion d'été";
        res = await post(
            toolCall("send_email", {
                to: "dest@example.net",
                cc: "copie@example.net",
                bcc: "cache@example.net",
                subject: phpSubject,
                body: "Bonjour,\nCeci est un test d'envoi PHP (été, cœur).\n.ligne commençant par un point\nFin.",
                in_reply_to: "<msg-101@example.com>",
            }),
        );
        body = await res.json();
        data = toolResult(body);
        check(
            "php: send_email -> status sent",
            !isToolError(body) &&
                data?.status === "sent" &&
                (data?.accepted ?? []).length === 3,
            JSON.stringify(body),
        );
        check(
            "php: le fake SMTP a reçu 1 message",
            smtpMessages.length === smtpBefore + 1,
            `messages=${smtpMessages.length}`,
        );
        checkSmtpMessage("php: send_email", smtpMessages[smtpBefore], {
            from: "test@example.com",
            rcpt: ["dest@example.net", "copie@example.net", "cache@example.net"],
            to: "dest@example.net",
            subject: phpSubject,
            inReplyTo: "<msg-101@example.com>",
            bodyMarkers: ["été", "cœur", "\n.ligne commençant par un point"],
        });
    } finally {
        php.kill("SIGTERM");
        await waitForExit(php);
        try {
            unlinkSync(PHP_CONFIG_PATH);
        } catch {
            // déjà supprimé
        }
        if (phpStderr.includes("PHP Fatal error")) {
            check("php: aucune erreur fatale PHP", false, phpStderr);
        }
    }
}

// ---------------------------------------------------------------------------
// Variante TS (handler Netlify via tsx)
// ---------------------------------------------------------------------------

async function runTsSuite(imapPort, smtpPort, smtpMessages) {
    const smtpBefore = smtpMessages.length;

    const env = {
        ...cleanEnv(),
        MCP_AUTH_TOKEN: TOKEN,
        IMAP_HOST: "127.0.0.1",
        IMAP_PORT: String(imapPort),
        IMAP_USER: "test@example.com",
        IMAP_PASSWORD: "testpass",
        IMAP_ENCRYPTION: "none",
        SMTP_HOST: "127.0.0.1",
        SMTP_PORT: String(smtpPort),
        SMTP_USER: "test@example.com",
        SMTP_PASSWORD: "testpass",
        SMTP_ENCRYPTION: "none",
        MAIL_FROM: "test@example.com",
        MAIL_FROM_NAME: "Test Sender",
    };

    const driver = spawn("npx", ["tsx", "test/ts-handler-driver.mts"], {
        cwd: ROOT,
        env,
        stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    driver.stdout.on("data", (d) => {
        stdout += d.toString();
    });
    driver.stderr.on("data", (d) => {
        stderr += d.toString();
    });
    const killer = setTimeout(() => driver.kill("SIGKILL"), 90000);
    const exitCode = await waitForExit(driver);
    clearTimeout(killer);

    const marker = stdout
        .split("\n")
        .find((l) => l.startsWith("__SMOKE_RESULTS__"));
    if (!marker) {
        check(
            "ts: le driver a produit des résultats",
            false,
            `exit=${exitCode} stdout=${truncate(stdout)} stderr=${truncate(stderr)}`,
        );
        return;
    }
    const results = new Map(
        JSON.parse(marker.slice("__SMOKE_RESULTS__".length)).map((r) => [
            r.name,
            r,
        ]),
    );
    const get = (name) => results.get(name) ?? {status: -1, body: null};

    check(
        "ts: 401 sans token",
        get("unauthorized").status === 401,
        JSON.stringify(get("unauthorized")),
    );
    check(
        "ts: GET -> 405",
        get("get-not-allowed").status === 405,
        JSON.stringify(get("get-not-allowed")),
    );
    check(
        "ts: initialize -> protocolVersion 2025-06-18",
        get("initialize").status === 200 &&
            get("initialize").body?.result?.protocolVersion === "2025-06-18",
        JSON.stringify(get("initialize")),
    );
    check(
        "ts: notifications/initialized -> 202",
        get("initialized-notification").status === 202,
        JSON.stringify(get("initialized-notification")),
    );

    const tools = (get("tools-list").body?.result?.tools ?? [])
        .map((t) => t.name)
        .sort();
    check(
        "ts: tools/list -> 6 outils",
        JSON.stringify(tools) ===
            JSON.stringify([
                "list_emails",
                "list_folders",
                "mark_email",
                "read_email",
                "search_emails",
                "send_email",
            ]),
        JSON.stringify(tools),
    );

    // list_folders — la variante TS renvoie directement un tableau de dossiers.
    let body = get("list-folders").body;
    let data = toolResult(body);
    const folderPaths = Array.isArray(data) ? data.map((f) => f.path) : [];
    check(
        "ts: list_folders contient INBOX et Archive",
        !isToolError(body) &&
            folderPaths.includes("INBOX") &&
            folderPaths.includes("Archive"),
        JSON.stringify(body),
    );

    // list_emails — tableau de résumés, plus récent d'abord.
    body = get("list-emails").body;
    data = toolResult(body);
    const uids = Array.isArray(data) ? data.map((e) => e.uid) : [];
    check(
        "ts: list_emails -> 3 messages, uid 103..101 (récent d'abord)",
        !isToolError(body) &&
            JSON.stringify(uids) === JSON.stringify([103, 102, 101]),
        JSON.stringify(body),
    );
    const mail101 = (Array.isArray(data) ? data : []).find(
        (e) => e.uid === 101,
    );
    check(
        "ts: list_emails sujet RFC 2047 décodé",
        mail101?.subject === SUBJECT_101_DECODED,
        JSON.stringify(mail101),
    );

    // read_email
    body = get("read-email").body;
    data = toolResult(body);
    check(
        "ts: read_email texte décodé (accents corrects)",
        !isToolError(body) &&
            BODY_101_MARKERS.every((m) => (data?.text ?? "").includes(m)),
        JSON.stringify(data?.text ?? body),
    );
    check(
        "ts: read_email pièce jointe listée",
        (data?.attachments ?? []).some(
            (a) =>
                a.filename === ATTACHMENT_101 &&
                a.contentType === "application/pdf",
        ),
        JSON.stringify(data?.attachments),
    );

    // search_emails
    body = get("search-emails").body;
    data = toolResult(body);
    const searchUids = (Array.isArray(data) ? data : [])
        .map((e) => e.uid)
        .sort();
    check(
        "ts: search_emails -> 2 résultats (uid 101 et 103)",
        !isToolError(body) &&
            JSON.stringify(searchUids) === JSON.stringify([101, 103]),
        JSON.stringify(body),
    );

    // mark_email
    body = get("mark-email").body;
    data = toolResult(body);
    check(
        "ts: mark_email -> ok",
        !isToolError(body) && data?.ok === true && data?.uid === 101,
        JSON.stringify(body),
    );

    // send_email
    body = get("send-email").body;
    data = toolResult(body);
    check(
        "ts: send_email -> messageId + 3 acceptés",
        !isToolError(body) &&
            typeof data?.messageId === "string" &&
            (data?.accepted ?? []).length === 3,
        JSON.stringify(body),
    );
    check(
        "ts: le fake SMTP a reçu 1 message",
        smtpMessages.length === smtpBefore + 1,
        `messages=${smtpMessages.length}`,
    );
    checkSmtpMessage("ts: send_email", smtpMessages[smtpBefore], {
        from: "test@example.com",
        rcpt: [
            "ts-dest@example.net",
            "ts-copie@example.net",
            "ts-cache@example.net",
        ],
        to: "ts-dest@example.net",
        subject: "Réponse : réunion d'été",
        inReplyTo: "<msg-101@example.com>",
        bodyMarkers: ["été", "cœur", "\n.ligne commençant par un point"],
    });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
    // Garde-fou global : si quelque chose bloque, on sort en erreur.
    const watchdog = setTimeout(() => {
        console.error("TIMEOUT: le smoke test a dépassé 150 s.");
        process.exit(1);
    }, 150000);
    watchdog.unref();

    const imap = await startFakeImapServer(0);
    const smtp = await startFakeSmtpServer(0);
    console.log(
        `Fakes démarrés : IMAP 127.0.0.1:${imap.port}, SMTP 127.0.0.1:${smtp.port}`,
    );

    try {
        console.log("\n--- Variante PHP (php-ovh/) ---");
        try {
            await runPhpSuite(imap.port, smtp.port, smtp.messages);
        } catch (err) {
            check("php: suite exécutée sans erreur", false, String(err));
        }

        console.log("\n--- Variante TypeScript (netlify/functions/mcp.ts) ---");
        try {
            await runTsSuite(imap.port, smtp.port, smtp.messages);
        } catch (err) {
            check("ts: suite exécutée sans erreur", false, String(err));
        }
    } finally {
        await imap.close();
        await smtp.close();
    }

    const failed = checks.filter((c) => !c.ok);
    console.log(
        `\nRésultat : ${checks.length - failed.length}/${checks.length} assertions OK` +
            (failed.length ? ` — ${failed.length} ÉCHEC(S)` : ""),
    );
    if (failed.length > 0) {
        process.exitCode = 1;
    }
}

main().catch((err) => {
    console.error("Erreur fatale du smoke test :", err);
    process.exit(1);
});
