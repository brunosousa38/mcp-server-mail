import {randomUUID} from "node:crypto";
import {pino} from "pino";
import {pinoHttp} from "pino-http";

const level = process.env.LOG_LEVEL ?? "info";

export const logger = pino({
    level,
    redact: {
        paths: [
            "req.headers.authorization",
            "req.headers.cookie",
            "req.headers['x-api-key']",
            'res.headers["set-cookie"]',
        ],
        remove: true,
    },
});

export const httpLogger = pinoHttp({
    logger,
    genReqId: (req, res) => {
        const incoming = req.headers["x-request-id"];
        const id = typeof incoming === "string" && incoming.length > 0
            ? incoming
            : randomUUID();
        res.setHeader("x-request-id", id);
        return id;
    },
    customLogLevel: (_req, res, err) => {
        if (err || res.statusCode >= 500) return "error";
        if (res.statusCode >= 400) return "warn";
        return "info";
    },
    serializers: {
        req(req) {
            return {
                id: req.id,
                method: req.method,
                url: req.url,
                remoteAddress: req.remoteAddress,
            };
        },
    },
});
