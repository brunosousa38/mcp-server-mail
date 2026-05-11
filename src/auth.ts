import {createHash, timingSafeEqual} from "node:crypto";
import type {RequestHandler} from "express";
import {logger} from "./logger.js";

function buildDigest(token: string): Buffer {
    return createHash("sha256").update(token).digest();
}

function rejectUnauthorized(
    res: Parameters<RequestHandler>[1],
    withWwwAuth: boolean,
): void {
    if (withWwwAuth) res.setHeader("WWW-Authenticate", 'Bearer realm="mcp"');
    res.status(401).json({
        jsonrpc: "2.0",
        error: {code: -32001, message: "Unauthorized"},
        id: null,
    });
}

export function bearerAuthMiddleware(expectedToken: string): RequestHandler {
    const expectedDigest = buildDigest(expectedToken);

    return (req, res, next) => {
        const header = req.header("authorization") ?? "";
        const match = /^Bearer\s+(.+)$/i.exec(header);

        if (!match) {
            logger.warn({ip: req.ip, path: req.path}, "Rejected: missing bearer token");
            rejectUnauthorized(res, true);
            return;
        }

        const presentedDigest = buildDigest(match[1]);
        if (!timingSafeEqual(expectedDigest, presentedDigest)) {
            logger.warn({ip: req.ip, path: req.path}, "Rejected: invalid bearer token");
            rejectUnauthorized(res, true);
            return;
        }

        next();
    };
}

// Validates the token from req.params.token (URL-based auth: /mcp/:token).
// The token is redacted from logs by the pino-http serializer in logger.ts.
export function urlTokenAuthMiddleware(expectedToken: string): RequestHandler {
    const expectedDigest = buildDigest(expectedToken);

    return (req, res, next) => {
        const presented = (req.params as Record<string, string>)["token"] ?? "";
        const presentedDigest = buildDigest(presented);

        if (!timingSafeEqual(expectedDigest, presentedDigest)) {
            logger.warn({ip: req.ip}, "Rejected: invalid URL token");
            rejectUnauthorized(res, false);
            return;
        }

        next();
    };
}
