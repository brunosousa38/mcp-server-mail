import {randomUUID} from "node:crypto";
import express, {type Express, type Request, type Response} from "express";
import cors from "cors";
import helmet from "helmet";
import {StreamableHTTPServerTransport} from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {isInitializeRequest} from "@modelcontextprotocol/sdk/types.js";
import type {AppConfig} from "./config.js";
import {bearerAuthMiddleware, urlTokenAuthMiddleware} from "./auth.js";
import {buildGeneralRateLimit, buildSendEmailLimiter} from "./rate-limit.js";
import {buildServer} from "./mcp-server.js";
import type {MailClient} from "./mail-client.js";
import {httpLogger, logger} from "./logger.js";

export interface HttpServerHandle {
    app: Express;
    transports: Map<string, StreamableHTTPServerTransport>;
}

export function createApp(
    config: AppConfig,
    mailClient: MailClient,
): HttpServerHandle {
    const app = express();
    app.disable("x-powered-by");
    app.set("trust proxy", config.trustProxy);

    app.use(httpLogger);
    app.use(helmet());

    if (config.allowedOrigins.length > 0) {
        app.use(
            cors({
                origin: config.allowedOrigins,
                credentials: false,
                methods: ["GET", "POST", "DELETE", "OPTIONS"],
                allowedHeaders: [
                    "Authorization",
                    "Content-Type",
                    "Accept",
                    "mcp-session-id",
                    "x-request-id",
                ],
                exposedHeaders: ["mcp-session-id", "x-request-id"],
            }),
        );
    }

    app.get("/healthz", (_req, res) => {
        res.json({status: "ok"});
    });

    const transports = new Map<string, StreamableHTTPServerTransport>();
    const sendEmailLimiter = buildSendEmailLimiter(config.sendRateLimitPerMin);

    // ── Shared MCP request handlers ────────────────────────────────────────────

    const handlePost = async (req: Request, res: Response) => {
        const headerSessionId = req.header("mcp-session-id");
        let transport = headerSessionId
            ? transports.get(headerSessionId)
            : undefined;

        try {
            if (!transport) {
                if (!isInitializeRequest(req.body)) {
                    res.status(400).json({
                        jsonrpc: "2.0",
                        error: {
                            code: -32000,
                            message: "No valid session — call initialize first",
                        },
                        id: null,
                    });
                    return;
                }

                const newTransport = new StreamableHTTPServerTransport({
                    sessionIdGenerator: () => randomUUID(),
                    onsessioninitialized: (id) => {
                        transports.set(id, newTransport);
                        logger.info({sessionId: id}, "MCP session initialized");
                    },
                });

                newTransport.onclose = () => {
                    if (newTransport.sessionId) {
                        transports.delete(newTransport.sessionId);
                        logger.info(
                            {sessionId: newTransport.sessionId},
                            "MCP session closed",
                        );
                    }
                };

                const server = buildServer({mailClient, sendEmailLimiter});
                await server.connect(newTransport);
                transport = newTransport;
            }

            await transport.handleRequest(req, res, req.body);
        } catch (err) {
            logger.error({err}, "Error handling POST /mcp");
            if (!res.headersSent) {
                res.status(500).json({
                    jsonrpc: "2.0",
                    error: {code: -32603, message: "Internal server error"},
                    id: null,
                });
            }
        }
    };

    const handleSession = async (req: Request, res: Response) => {
        const sessionId = req.header("mcp-session-id");
        const transport = sessionId ? transports.get(sessionId) : undefined;
        if (!transport) {
            res.status(400).send("Invalid or missing session id");
            return;
        }
        try {
            await transport.handleRequest(req, res);
        } catch (err) {
            logger.error({err}, "Error handling session request");
            if (!res.headersSent) {
                res.status(500).send("Internal server error");
            }
        }
    };

    const jsonBody = express.json({limit: "1mb"});
    const rateLimit = buildGeneralRateLimit(config.rateLimitPerMin);

    // ── Route 1: /mcp — header-based Bearer auth ───────────────────────────────

    const mcpRouter = express.Router();
    mcpRouter.use(rateLimit);
    mcpRouter.use(bearerAuthMiddleware(config.mcpAuthToken));
    mcpRouter.use(jsonBody);
    mcpRouter.post("/", handlePost);
    mcpRouter.get("/", handleSession);
    mcpRouter.delete("/", handleSession);
    app.use("/mcp", mcpRouter);

    // ── Route 2: /mcp/:token — URL-embedded token auth ────────────────────────
    // Use this URL directly in Claude's connector UI: https://domain/mcp/TOKEN/
    // The token is masked in logs. Note: the token will appear in browser
    // history and HTTP access logs on intermediate proxies — prefer header auth
    // when your client supports it.

    const urlTokenRouter = express.Router({mergeParams: true});
    urlTokenRouter.use(rateLimit);
    urlTokenRouter.use(urlTokenAuthMiddleware(config.mcpAuthToken));
    urlTokenRouter.use(jsonBody);
    urlTokenRouter.post("/", handlePost);
    urlTokenRouter.get("/", handleSession);
    urlTokenRouter.delete("/", handleSession);
    app.use("/mcp/:token", urlTokenRouter);

    app.use((_req, res) => {
        res.status(404).json({error: "Not Found"});
    });

    return {app, transports};
}
