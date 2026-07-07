/**
 * Mini serveur IMAP canné pour les smoke tests (aucun TLS : les variantes
 * acceptent encryption "none").
 *
 * Scénario servi :
 *  - LOGIN test@example.com / testpass (arguments quotés OU littéraux {N},
 *    avec réponse de continuation "+ OK") ;
 *  - 2 dossiers : INBOX (3 messages, UID 101/102/103) et Archive (vide) ;
 *  - FETCH / UID FETCH : UID, FLAGS, RFC822.SIZE, ENVELOPE,
 *    BODY.PEEK[HEADER.FIELDS (...)] et BODY.PEEK[] (message complet) ;
 *  - UID SEARCH -> "* SEARCH 101 103" (canné) ;
 *  - UID STORE +FLAGS/-FLAGS -> OK.
 *
 * Utilisable en module (startFakeImapServer) ou en CLI :
 *   node test/fake-imap-server.mjs <port>
 */

import net from "node:net";

const CRLF = "\r\n";
const USER = "test@example.com";
const PASS = "testpass";

// ---------------------------------------------------------------------------
// Messages cannés
// ---------------------------------------------------------------------------

/** Encode une chaîne UTF-8 en quoted-printable (suffisant pour nos corps). */
function qpEncode(str) {
    const bytes = Buffer.from(str, "utf8");
    let out = "";
    let lineLen = 0;
    const push = (chunk) => {
        if (lineLen + chunk.length > 72) {
            out += "=" + CRLF;
            lineLen = 0;
        }
        out += chunk;
        lineLen += chunk.length;
    };
    for (let i = 0; i < bytes.length; i++) {
        const b = bytes[i];
        if (b === 0x0a) {
            // \n -> saut de ligne dur CRLF
            out += CRLF;
            lineLen = 0;
        } else if (b === 0x0d) {
            // ignoré (les corps sont définis avec \n)
        } else if (b === 0x3d || b < 0x20 || b > 0x7e) {
            push("=" + b.toString(16).toUpperCase().padStart(2, "0"));
        } else {
            push(String.fromCharCode(b));
        }
    }
    return out;
}

function rfc2047(str) {
    return "=?UTF-8?B?" + Buffer.from(str, "utf8").toString("base64") + "?=";
}

export const SUBJECT_101_DECODED = "Réunion d'équipe";
export const BODY_101_MARKERS = ["café", "cœur", "naïveté", "À bientôt"];
export const ATTACHMENT_101 = "rapport.pdf";

const BODY_101_TEXT =
    "Bonjour,\n\nVoici le résumé de la réunion : café, cœur, naïveté.\n\nÀ bientôt !\n";

function buildMessage101() {
    const lines = [
        "Date: Mon, 01 Jun 2026 10:00:00 +0000",
        "From: Alice Dupont <alice@example.com>",
        "To: test@example.com",
        `Subject: ${rfc2047(SUBJECT_101_DECODED)}`,
        "Message-ID: <msg-101@example.com>",
        "MIME-Version: 1.0",
        'Content-Type: multipart/mixed; boundary="outer101"',
        "",
        "--outer101",
        'Content-Type: multipart/alternative; boundary="alt101"',
        "",
        "--alt101",
        "Content-Type: text/plain; charset=utf-8",
        "Content-Transfer-Encoding: quoted-printable",
        "",
        qpEncode(BODY_101_TEXT),
        "--alt101",
        "Content-Type: text/html; charset=utf-8",
        "Content-Transfer-Encoding: quoted-printable",
        "",
        qpEncode("<p>Bonjour,</p><p>Voici le résumé de la réunion.</p>\n"),
        "--alt101--",
        "",
        "--outer101",
        'Content-Type: application/pdf; name="rapport.pdf"',
        'Content-Disposition: attachment; filename="rapport.pdf"',
        "Content-Transfer-Encoding: base64",
        "",
        Buffer.from("%PDF-1.4 fake pdf for smoke tests\n").toString("base64"),
        "--outer101--",
        "",
    ];
    return lines.join(CRLF);
}

function buildSimpleMessage({date, from, to, subject, messageId, body}) {
    return [
        `Date: ${date}`,
        `From: ${from}`,
        `To: ${to}`,
        `Subject: ${subject}`,
        `Message-ID: ${messageId}`,
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=utf-8",
        "Content-Transfer-Encoding: quoted-printable",
        "",
        qpEncode(body),
        "",
    ].join(CRLF);
}

/** Adresse ENVELOPE : ((name adl mailbox host)). */
function envAddr(name, mailbox, host) {
    const n = name === null ? "NIL" : `"${name}"`;
    return `((${n} NIL "${mailbox}" "${host}"))`;
}

function makeMessages() {
    const raw101 = buildMessage101();
    const raw102 = buildSimpleMessage({
        date: "Tue, 02 Jun 2026 11:30:00 +0000",
        from: "Bob Martin <bob@example.org>",
        to: "test@example.com",
        subject: "Plain ASCII subject",
        messageId: "<msg-102@example.org>",
        body: "Hello, this is a plain message.\n",
    });
    const raw103 = buildSimpleMessage({
        date: "Wed, 03 Jun 2026 09:15:00 +0000",
        from: "carol@example.net",
        to: "test@example.com",
        subject: "Invoice #42",
        messageId: "<msg-103@example.net>",
        body: "Please find invoice #42.\nTotal: 42 EUR.\n",
    });

    return [
        {
            seq: 1,
            uid: 101,
            flags: [],
            raw: raw101,
            headerFields: [
                "Date: Mon, 01 Jun 2026 10:00:00 +0000",
                "From: Alice Dupont <alice@example.com>",
                "To: test@example.com",
                `Subject: ${rfc2047(SUBJECT_101_DECODED)}`,
                "Message-ID: <msg-101@example.com>",
            ],
            envelope:
                `("Mon, 01 Jun 2026 10:00:00 +0000" "${rfc2047(SUBJECT_101_DECODED)}" ` +
                `${envAddr("Alice Dupont", "alice", "example.com")} ` +
                `${envAddr("Alice Dupont", "alice", "example.com")} ` +
                `${envAddr("Alice Dupont", "alice", "example.com")} ` +
                `${envAddr(null, "test", "example.com")} ` +
                `NIL NIL NIL "<msg-101@example.com>")`,
        },
        {
            seq: 2,
            uid: 102,
            flags: ["\\Seen"],
            raw: raw102,
            headerFields: [
                "Date: Tue, 02 Jun 2026 11:30:00 +0000",
                "From: Bob Martin <bob@example.org>",
                "To: test@example.com",
                "Subject: Plain ASCII subject",
                "Message-ID: <msg-102@example.org>",
            ],
            envelope:
                `("Tue, 02 Jun 2026 11:30:00 +0000" "Plain ASCII subject" ` +
                `${envAddr("Bob Martin", "bob", "example.org")} ` +
                `${envAddr("Bob Martin", "bob", "example.org")} ` +
                `${envAddr("Bob Martin", "bob", "example.org")} ` +
                `${envAddr(null, "test", "example.com")} ` +
                `NIL NIL NIL "<msg-102@example.org>")`,
        },
        {
            seq: 3,
            uid: 103,
            flags: [],
            raw: raw103,
            headerFields: [
                "Date: Wed, 03 Jun 2026 09:15:00 +0000",
                "From: carol@example.net",
                "To: test@example.com",
                "Subject: Invoice #42",
                "Message-ID: <msg-103@example.net>",
            ],
            envelope:
                `("Wed, 03 Jun 2026 09:15:00 +0000" "Invoice #42" ` +
                `${envAddr(null, "carol", "example.net")} ` +
                `${envAddr(null, "carol", "example.net")} ` +
                `${envAddr(null, "carol", "example.net")} ` +
                `${envAddr(null, "test", "example.com")} ` +
                `NIL NIL NIL "<msg-103@example.net>")`,
        },
    ];
}

const MESSAGES = makeMessages();
const FOLDERS = {
    INBOX: {messages: MESSAGES, unseen: 2},
    Archive: {messages: [], unseen: 0},
};

// ---------------------------------------------------------------------------
// Découpage des commandes reçues (lignes + littéraux {N} / {N+})
// ---------------------------------------------------------------------------

const LITERAL_MARK = "\x00";

/**
 * Assemble les commandes IMAP complètes à partir du flux : chaque littéral
 * annoncé par {N} (continuation "+ OK" émise) ou {N+} (LITERAL+) est remplacé
 * par un marqueur \x00<index>\x00 et sa valeur stockée à part.
 */
class CommandAssembler {
    constructor(socket, onCommand) {
        this.socket = socket;
        this.onCommand = onCommand;
        this.buffer = Buffer.alloc(0);
        this.pendingLiteral = null; // octets restants à lire
        this.current = ""; // texte de commande accumulé
        this.literals = [];
    }

    feed(chunk) {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        this.drain();
    }

    drain() {
        for (;;) {
            if (this.pendingLiteral !== null) {
                if (this.buffer.length < this.pendingLiteral) return;
                const data = this.buffer.subarray(0, this.pendingLiteral);
                this.buffer = this.buffer.subarray(this.pendingLiteral);
                this.pendingLiteral = null;
                this.current += LITERAL_MARK + this.literals.length + LITERAL_MARK;
                this.literals.push(data.toString("utf8"));
                continue;
            }
            const idx = this.buffer.indexOf(0x0a); // \n
            if (idx === -1) return;
            let line = this.buffer.subarray(0, idx).toString("utf8");
            this.buffer = this.buffer.subarray(idx + 1);
            line = line.replace(/\r$/, "");

            const m = /\{(\d+)(\+)?\}$/.exec(line);
            if (m) {
                this.current += line.slice(0, m.index);
                this.pendingLiteral = Number(m[1]);
                if (!m[2]) {
                    this.socket.write("+ OK ready for literal" + CRLF);
                }
                continue;
            }
            const full = this.current + line;
            const literals = this.literals;
            this.current = "";
            this.literals = [];
            if (full.trim() !== "") {
                this.onCommand(full, literals);
            }
        }
    }
}

/** Découpe une commande en tokens (atomes, quoted-strings, littéraux résolus). */
function tokenize(commandText, literals) {
    const tokens = [];
    let i = 0;
    const n = commandText.length;
    while (i < n) {
        const c = commandText[i];
        if (c === " ") {
            i++;
        } else if (c === '"') {
            let val = "";
            i++;
            while (i < n && commandText[i] !== '"') {
                if (commandText[i] === "\\" && i + 1 < n) {
                    val += commandText[i + 1];
                    i += 2;
                } else {
                    val += commandText[i];
                    i++;
                }
            }
            i++; // guillemet fermant
            tokens.push(val);
        } else if (c === LITERAL_MARK) {
            const end = commandText.indexOf(LITERAL_MARK, i + 1);
            const litIndex = Number(commandText.slice(i + 1, end));
            tokens.push(literals[litIndex] ?? "");
            i = end + 1;
        } else {
            let val = "";
            while (i < n && commandText[i] !== " ") {
                if (commandText[i] === LITERAL_MARK) break;
                val += commandText[i];
                i++;
            }
            tokens.push(val);
        }
    }
    return tokens;
}

// ---------------------------------------------------------------------------
// Réponses FETCH
// ---------------------------------------------------------------------------

/** Développe un sequence-set ("1:3", "101,103", "1:*") en liste de messages. */
function resolveSet(set, byUid, folder) {
    const msgs = folder.messages;
    if (msgs.length === 0) return [];
    const maxVal = byUid ? Math.max(...msgs.map((m) => m.uid)) : msgs.length;
    const selected = [];
    for (const part of set.split(",")) {
        let [lo, hi] = part.includes(":") ? part.split(":") : [part, part];
        lo = lo === "*" ? maxVal : Number(lo);
        hi = hi === "*" ? maxVal : Number(hi);
        if (lo > hi) [lo, hi] = [hi, lo];
        for (const msg of msgs) {
            const key = byUid ? msg.uid : msg.seq;
            if (key >= lo && key <= hi && !selected.includes(msg)) {
                selected.push(msg);
            }
        }
    }
    return selected.sort((a, b) => a.seq - b.seq);
}

/** Construit la réponse FETCH d'un message selon les items demandés. */
function fetchResponse(msg, itemsText, byUid) {
    const upper = itemsText.toUpperCase();
    const parts = [];

    // UID toujours renvoyé pour un UID FETCH (RFC 3501 §6.4.8)
    if (byUid || upper.includes("UID")) {
        parts.push(`UID ${msg.uid}`);
    }
    if (upper.includes("FLAGS")) {
        parts.push(`FLAGS (${msg.flags.join(" ")})`);
    }
    if (upper.includes("RFC822.SIZE")) {
        parts.push(`RFC822.SIZE ${Buffer.byteLength(msg.raw)}`);
    }
    if (upper.includes("ENVELOPE")) {
        parts.push(`ENVELOPE ${msg.envelope}`);
    }

    let literal = null;
    let sectionLabel = null;
    const secMatch = /BODY(?:\.PEEK)?\[([^\]]*)\]/i.exec(itemsText);
    if (secMatch) {
        const section = secMatch[1];
        if (/^HEADER\.FIELDS/i.test(section)) {
            literal = msg.headerFields.join(CRLF) + CRLF + CRLF;
            sectionLabel = `BODY[${section}]`;
        } else if (section === "" || /^TEXT$/i.test(section)) {
            literal = msg.raw;
            sectionLabel = `BODY[${section}]`;
        }
    }

    let head = `* ${msg.seq} FETCH (${parts.join(" ")}`;
    if (literal !== null) {
        const bytes = Buffer.byteLength(literal, "utf8");
        head += `${parts.length > 0 ? " " : ""}${sectionLabel} {${bytes}}` + CRLF;
        return head + literal + ")" + CRLF;
    }
    return head + ")" + CRLF;
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

const CAPABILITIES = "IMAP4rev1 LITERAL+";

function handleConnection(socket) {
    const state = {authed: false, selected: null, expectAuthPlain: null};

    const send = (s) => {
        if (!socket.destroyed) socket.write(s);
    };

    send(`* OK [CAPABILITY ${CAPABILITIES}] Fake IMAP server ready` + CRLF);

    const assembler = new CommandAssembler(socket, (text, literals) => {
        // Continuation AUTHENTICATE PLAIN : la ligne est la réponse base64.
        if (state.expectAuthPlain) {
            const tag = state.expectAuthPlain;
            state.expectAuthPlain = null;
            const decoded = Buffer.from(text.trim(), "base64").toString("utf8");
            const [, user, pass] = decoded.split("\x00");
            if (user === USER && pass === PASS) {
                state.authed = true;
                send(`${tag} OK [CAPABILITY ${CAPABILITIES}] Authenticated` + CRLF);
            } else {
                send(`${tag} NO Authentication failed` + CRLF);
            }
            return;
        }

        const tokens = tokenize(text, literals);
        if (tokens.length < 2) {
            send(`${tokens[0] ?? "*"} BAD Invalid command` + CRLF);
            return;
        }
        const tag = tokens[0];
        let verb = tokens[1].toUpperCase();
        let args = tokens.slice(2);
        let byUid = false;
        if (verb === "UID" && args.length > 0) {
            byUid = true;
            verb = args[0].toUpperCase();
            args = args.slice(1);
        }

        switch (verb) {
            case "CAPABILITY":
                send(`* CAPABILITY ${CAPABILITIES}` + CRLF);
                send(`${tag} OK CAPABILITY completed` + CRLF);
                break;

            case "NOOP":
            case "CHECK":
            case "CLOSE":
            case "UNSELECT":
                send(`${tag} OK ${verb} completed` + CRLF);
                break;

            case "ID":
                send("* ID NIL" + CRLF);
                send(`${tag} OK ID completed` + CRLF);
                break;

            case "ENABLE":
                send("* ENABLED" + CRLF);
                send(`${tag} OK ENABLE completed` + CRLF);
                break;

            case "LOGIN": {
                const [user, pass] = args;
                if (user === USER && pass === PASS) {
                    state.authed = true;
                    send(`${tag} OK [CAPABILITY ${CAPABILITIES}] LOGIN completed` + CRLF);
                } else {
                    send(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials` + CRLF);
                }
                break;
            }

            case "AUTHENTICATE": {
                if ((args[0] ?? "").toUpperCase() !== "PLAIN") {
                    send(`${tag} NO Unsupported mechanism` + CRLF);
                    break;
                }
                if (args.length > 1) {
                    // initial response (SASL-IR)
                    const decoded = Buffer.from(args[1], "base64").toString("utf8");
                    const [, user, pass] = decoded.split("\x00");
                    if (user === USER && pass === PASS) {
                        state.authed = true;
                        send(`${tag} OK [CAPABILITY ${CAPABILITIES}] Authenticated` + CRLF);
                    } else {
                        send(`${tag} NO Authentication failed` + CRLF);
                    }
                } else {
                    state.expectAuthPlain = tag;
                    send("+ " + CRLF);
                }
                break;
            }

            case "LIST":
            case "LSUB": {
                const pattern = args[1] ?? "*";
                if (pattern === "") {
                    send(`* ${verb} (\\Noselect) "." ""` + CRLF);
                } else {
                    for (const name of Object.keys(FOLDERS)) {
                        if (
                            pattern === "*" ||
                            pattern === "%" ||
                            pattern.toUpperCase() === name.toUpperCase()
                        ) {
                            send(`* ${verb} (\\HasNoChildren) "." ${name}` + CRLF);
                        }
                    }
                }
                send(`${tag} OK ${verb} completed` + CRLF);
                break;
            }

            case "STATUS": {
                const name = args[0] ?? "";
                const folder = FOLDERS[name] ?? FOLDERS[name.toUpperCase()];
                if (!folder) {
                    send(`${tag} NO No such mailbox` + CRLF);
                    break;
                }
                send(
                    `* STATUS "${name}" (MESSAGES ${folder.messages.length} UNSEEN ${folder.unseen} UIDNEXT 104 UIDVALIDITY 1)` +
                        CRLF,
                );
                send(`${tag} OK STATUS completed` + CRLF);
                break;
            }

            case "SELECT":
            case "EXAMINE": {
                const name = args[0] ?? "";
                const key = Object.keys(FOLDERS).find(
                    (k) => k.toUpperCase() === name.toUpperCase(),
                );
                if (!key) {
                    send(`${tag} NO [NONEXISTENT] No such mailbox` + CRLF);
                    break;
                }
                const folder = FOLDERS[key];
                state.selected = key;
                send("* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)" + CRLF);
                send(
                    "* OK [PERMANENTFLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft \\*)] Flags permitted" +
                        CRLF,
                );
                send(`* ${folder.messages.length} EXISTS` + CRLF);
                send("* 0 RECENT" + CRLF);
                send("* OK [UIDVALIDITY 1] UIDs valid" + CRLF);
                send("* OK [UIDNEXT 104] Predicted next UID" + CRLF);
                const mode = verb === "EXAMINE" ? "READ-ONLY" : "READ-WRITE";
                send(`${tag} OK [${mode}] ${verb} completed` + CRLF);
                break;
            }

            case "FETCH": {
                if (!state.selected) {
                    send(`${tag} BAD No mailbox selected` + CRLF);
                    break;
                }
                const folder = FOLDERS[state.selected];
                const set = args[0] ?? "";
                // Tout ce qui suit le sequence-set = liste d'items demandés.
                const m = /FETCH\s+\S+\s+([\s\S]*)$/i.exec(text);
                const itemsText = m ? m[1] : "";
                for (const msg of resolveSet(set, byUid, folder)) {
                    send(fetchResponse(msg, itemsText, byUid));
                }
                send(`${tag} OK FETCH completed` + CRLF);
                break;
            }

            case "SEARCH": {
                if (!state.selected) {
                    send(`${tag} BAD No mailbox selected` + CRLF);
                    break;
                }
                if (state.selected === "INBOX") {
                    send(byUid ? "* SEARCH 101 103" + CRLF : "* SEARCH 1 3" + CRLF);
                } else {
                    send("* SEARCH" + CRLF);
                }
                send(`${tag} OK SEARCH completed` + CRLF);
                break;
            }

            case "STORE": {
                if (!state.selected) {
                    send(`${tag} BAD No mailbox selected` + CRLF);
                    break;
                }
                const folder = FOLDERS[state.selected];
                const set = args[0] ?? "";
                const op = (args[1] ?? "").toUpperCase();
                const adding = op.startsWith("+");
                const silent = op.includes(".SILENT");
                for (const msg of resolveSet(set, byUid, folder)) {
                    if (adding && !msg.flags.includes("\\Seen")) {
                        msg.flags.push("\\Seen");
                    } else if (!adding) {
                        msg.flags = msg.flags.filter((f) => f !== "\\Seen");
                    }
                    if (!silent) {
                        send(
                            `* ${msg.seq} FETCH (UID ${msg.uid} FLAGS (${msg.flags.join(" ")}))` +
                                CRLF,
                        );
                    }
                }
                send(`${tag} OK STORE completed` + CRLF);
                break;
            }

            case "LOGOUT":
                send("* BYE Logging out" + CRLF);
                send(`${tag} OK LOGOUT completed` + CRLF);
                socket.end();
                break;

            default:
                send(`${tag} BAD Unknown command: ${verb}` + CRLF);
        }
    });

    socket.on("data", (chunk) => {
        try {
            assembler.feed(chunk);
        } catch (err) {
            send(`* BAD Server error: ${err.message}` + CRLF);
            socket.destroy();
        }
    });
    socket.on("error", () => socket.destroy());
}

// ---------------------------------------------------------------------------
// Démarrage
// ---------------------------------------------------------------------------

/**
 * Démarre le fake sur `port` (0 = port libre).
 * @returns {Promise<{port: number, close: () => Promise<void>}>}
 */
export function startFakeImapServer(port = 0) {
    return new Promise((resolve, reject) => {
        const sockets = new Set();
        const server = net.createServer((socket) => {
            sockets.add(socket);
            socket.on("close", () => sockets.delete(socket));
            handleConnection(socket);
        });
        server.on("error", reject);
        server.listen(port, "127.0.0.1", () => {
            resolve({
                port: server.address().port,
                close: () =>
                    new Promise((res) => {
                        for (const s of sockets) s.destroy();
                        server.close(() => res());
                    }),
            });
        });
    });
}

// Mode CLI : node test/fake-imap-server.mjs <port>
const isMain =
    process.argv[1] &&
    import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1]).href;
if (isMain) {
    const cliPort = Number(process.argv[2] ?? 1143);
    startFakeImapServer(cliPort).then(({port}) => {
        console.log(`LISTENING ${port}`);
    });
}
