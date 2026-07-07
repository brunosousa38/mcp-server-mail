import {createHash, timingSafeEqual} from "node:crypto";

/**
 * Vérifie le token d'authentification présenté par la requête, soit via le
 * header `Authorization: Bearer <token>`, soit via le paramètre de query
 * `?token=<token>` (indispensable : les connecteurs personnalisés de
 * claude.ai / Claude Desktop ne permettent pas d'en-têtes custom).
 *
 * Comparaison en temps constant sur des digests sha256, comme dans
 * l'implémentation précédente.
 */
export function verifyToken(req: Request, expectedToken: string): boolean {
    const presented = extractToken(req);
    if (!presented) return false;

    const expectedDigest = createHash("sha256").update(expectedToken).digest();
    const presentedDigest = createHash("sha256").update(presented).digest();

    return timingSafeEqual(expectedDigest, presentedDigest);
}

function extractToken(req: Request): string | null {
    const authHeader = req.headers.get("authorization") ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(authHeader);
    if (match) return match[1];

    try {
        const url = new URL(req.url);
        return url.searchParams.get("token");
    } catch {
        return null;
    }
}
