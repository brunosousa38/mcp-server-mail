import {createHash, timingSafeEqual} from "node:crypto";
import type {RequestHandler} from "express";
import {logger} from "./logger.js";

export function bearerAuthMiddleware(expectedToken: string): RequestHandler {
    const expectedDigest = createHash("sha256").update(expectedToken).digest();

    return (req, res, next) => {
        const header = req.header("authorization") ?? "";
        const match = /^Bearer\s+(.+)$/i.exec(header);

        if (!match) {
            res.setHeader("WWW-Authenticate", 'Bearer realm="mcp"');
            logger.warn(
                {ip: req.ip, path: req.path},
                "Rejected request without bearer token",
            );
            res.status(401).json({
                jsonrpc: "2.0",
                error: {code: -32001, message: "Unauthorized"},
                id: null,
            });
            return;
        }

        const presentedDigest = createHash("sha256")
            .update(match[1])
            .digest();

        if (!timingSafeEqual(expectedDigest, presentedDigest)) {
            res.setHeader("WWW-Authenticate", 'Bearer realm="mcp"');
            logger.warn(
                {ip: req.ip, path: req.path},
                "Rejected request with invalid bearer token",
            );
            res.status(401).json({
                jsonrpc: "2.0",
                error: {code: -32001, message: "Unauthorized"},
                id: null,
            });
            return;
        }

        next();
    };
}
