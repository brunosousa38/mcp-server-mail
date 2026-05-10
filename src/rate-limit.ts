import rateLimit from "express-rate-limit";
import type {RequestHandler} from "express";

export function buildGeneralRateLimit(perMinute: number): RequestHandler {
    return rateLimit({
        windowMs: 60_000,
        limit: perMinute,
        standardHeaders: "draft-7",
        legacyHeaders: false,
        message: {
            jsonrpc: "2.0",
            error: {code: -32002, message: "Too Many Requests"},
            id: null,
        },
    });
}

export class TokenBucket {
    private tokens: number;
    private lastRefill: number;

    constructor(
        private readonly capacity: number,
        private readonly refillPerMs: number,
    ) {
        this.tokens = capacity;
        this.lastRefill = Date.now();
    }

    tryConsume(): boolean {
        const now = Date.now();
        const elapsed = now - this.lastRefill;
        if (elapsed > 0) {
            this.tokens = Math.min(
                this.capacity,
                this.tokens + elapsed * this.refillPerMs,
            );
            this.lastRefill = now;
        }
        if (this.tokens >= 1) {
            this.tokens -= 1;
            return true;
        }
        return false;
    }
}

export function buildSendEmailLimiter(perMinute: number): TokenBucket {
    return new TokenBucket(perMinute, perMinute / 60_000);
}
