/**
 * Mini serveur SMTP canné pour les smoke tests (pas de TLS).
 *
 * Dialogue : 220 -> EHLO (250-AUTH LOGIN PLAIN) -> AUTH LOGIN/PLAIN (235,
 * accepte tout) -> MAIL FROM/RCPT TO (250) -> DATA (354, collecte jusqu'à
 * CRLF.CRLF, 250) -> QUIT (221).
 *
 * Chaque message reçu (enveloppe + data) est enregistré ; en mode CLI le
 * tableau complet est réécrit en JSON dans le fichier passé en argument :
 *   node test/fake-smtp-server.mjs <port> <fichier-sortie.json>
 * En mode module (startFakeSmtpServer), les messages sont exposés via
 * `messages` et un callback `onMessage` optionnel.
 */

import net from "node:net";
import {writeFileSync} from "node:fs";

const CRLF = "\r\n";

function handleConnection(socket, recordMessage) {
    const session = {
        from: null,
        rcpt: [],
        inData: false,
        dataBuffer: Buffer.alloc(0),
        authState: null, // null | "login-user" | "login-pass" | "plain"
    };
    let buffer = Buffer.alloc(0);

    const send = (line) => {
        if (!socket.destroyed) socket.write(line + CRLF);
    };

    send("220 fake-smtp.local ESMTP smoke-test server");

    const resetEnvelope = () => {
        session.from = null;
        session.rcpt = [];
        session.dataBuffer = Buffer.alloc(0);
    };

    const handleLine = (line) => {
        // Continuations AUTH
        if (session.authState === "login-user") {
            session.authState = "login-pass";
            send("334 UGFzc3dvcmQ6"); // "Password:"
            return;
        }
        if (session.authState === "login-pass" || session.authState === "plain") {
            session.authState = null;
            send("235 2.7.0 Authentication successful");
            return;
        }

        const upper = line.toUpperCase();
        if (upper.startsWith("EHLO")) {
            send("250-fake-smtp.local");
            send("250-AUTH LOGIN PLAIN");
            send("250-8BITMIME");
            send("250 OK");
        } else if (upper.startsWith("HELO")) {
            send("250 fake-smtp.local");
        } else if (upper.startsWith("AUTH LOGIN")) {
            if (line.trim().split(/\s+/).length > 2) {
                // AUTH LOGIN <base64-user> (initial-response)
                session.authState = "login-pass";
                send("334 UGFzc3dvcmQ6");
            } else {
                session.authState = "login-user";
                send("334 VXNlcm5hbWU6"); // "Username:"
            }
        } else if (upper.startsWith("AUTH PLAIN")) {
            if (line.trim().split(/\s+/).length > 2) {
                send("235 2.7.0 Authentication successful");
            } else {
                session.authState = "plain";
                send("334 ");
            }
        } else if (upper.startsWith("MAIL FROM:")) {
            const m = /<([^>]*)>/.exec(line);
            session.from = m ? m[1] : line.slice(10).trim();
            send("250 2.1.0 OK");
        } else if (upper.startsWith("RCPT TO:")) {
            const m = /<([^>]*)>/.exec(line);
            session.rcpt.push(m ? m[1] : line.slice(8).trim());
            send("250 2.1.5 OK");
        } else if (upper.startsWith("DATA")) {
            if (!session.from || session.rcpt.length === 0) {
                send("503 5.5.1 Bad sequence of commands");
                return;
            }
            session.inData = true;
            send("354 End data with <CR><LF>.<CR><LF>");
        } else if (upper.startsWith("RSET")) {
            resetEnvelope();
            send("250 2.0.0 OK");
        } else if (upper.startsWith("NOOP")) {
            send("250 2.0.0 OK");
        } else if (upper.startsWith("QUIT")) {
            send("221 2.0.0 Bye");
            socket.end();
        } else {
            send("502 5.5.2 Command not implemented");
        }
    };

    socket.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        for (;;) {
            if (session.inData) {
                const endMark = Buffer.from(CRLF + "." + CRLF);
                const idx = buffer.indexOf(endMark);
                if (idx === -1) return;
                let data = buffer.subarray(0, idx).toString("utf8");
                buffer = buffer.subarray(idx + endMark.length);
                session.inData = false;
                // Dé-dot-stuffing
                data = data.replace(/^\.\./gm, ".");
                recordMessage({
                    from: session.from,
                    rcpt: [...session.rcpt],
                    data,
                });
                resetEnvelope();
                send("250 2.0.0 OK: queued as SMOKE-" + Date.now());
                continue;
            }
            const nl = buffer.indexOf(0x0a);
            if (nl === -1) return;
            const line = buffer.subarray(0, nl).toString("utf8").replace(/\r$/, "");
            buffer = buffer.subarray(nl + 1);
            handleLine(line);
        }
    });
    socket.on("error", () => socket.destroy());
}

/**
 * Démarre le fake sur `port` (0 = port libre).
 * @param {number} port
 * @param {(msg: {from: string, rcpt: string[], data: string}) => void} [onMessage]
 * @returns {Promise<{port: number, messages: Array, close: () => Promise<void>}>}
 */
export function startFakeSmtpServer(port = 0, onMessage) {
    return new Promise((resolve, reject) => {
        const messages = [];
        const sockets = new Set();
        const record = (msg) => {
            messages.push(msg);
            if (onMessage) onMessage(msg);
        };
        const server = net.createServer((socket) => {
            sockets.add(socket);
            socket.on("close", () => sockets.delete(socket));
            handleConnection(socket, record);
        });
        server.on("error", reject);
        server.listen(port, "127.0.0.1", () => {
            resolve({
                port: server.address().port,
                messages,
                close: () =>
                    new Promise((res) => {
                        for (const s of sockets) s.destroy();
                        server.close(() => res());
                    }),
            });
        });
    });
}

// Mode CLI : node test/fake-smtp-server.mjs <port> <fichier-sortie.json>
const isMain =
    process.argv[1] &&
    import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1]).href;
if (isMain) {
    const cliPort = Number(process.argv[2] ?? 1025);
    const outFile = process.argv[3];
    if (!outFile) {
        console.error("Usage: node test/fake-smtp-server.mjs <port> <out.json>");
        process.exit(2);
    }
    const collected = [];
    // Le fichier est réécrit après chaque message reçu.
    const flush = () => writeFileSync(outFile, JSON.stringify(collected, null, 2));
    startFakeSmtpServer(cliPort, (msg) => {
        collected.push(msg);
        flush();
    }).then(({port}) => {
        flush();
        console.log(`LISTENING ${port}`);
        process.on("SIGTERM", () => {
            flush();
            process.exit(0);
        });
    });
}
