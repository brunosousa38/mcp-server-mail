import type {Config, Context} from "@netlify/functions";
import {toReqRes, toFetchResponse} from "fetch-to-node";
import {StreamableHTTPServerTransport} from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {loadConfig} from "../../src/config.js";
import {verifyToken} from "../../src/auth.js";
import {buildServer} from "../../src/mcp-server.js";

function jsonRpcError(
    status: number,
    code: number,
    message: string,
    extraHeaders?: Record<string, string>,
): Response {
    return new Response(
        JSON.stringify({jsonrpc: "2.0", error: {code, message}, id: null}),
        {
            status,
            headers: {"Content-Type": "application/json", ...extraHeaders},
        },
    );
}

export default async (req: Request, _context: Context): Promise<Response> => {
    let appConfig;
    try {
        appConfig = loadConfig();
    } catch (err) {
        return jsonRpcError(
            500,
            -32603,
            `Server configuration error: ${(err as Error).message}`,
        );
    }

    if (!verifyToken(req, appConfig.mcpAuthToken)) {
        return jsonRpcError(401, -32001, "Unauthorized", {
            "WWW-Authenticate": 'Bearer realm="mcp"',
        });
    }

    // Serveur stateless sans SSE : seul POST est supporté (pas de GET/DELETE).
    if (req.method !== "POST") {
        return jsonRpcError(405, -32000, "Method not allowed");
    }

    // req.clone() est indispensable : depuis le SDK MCP 1.25+, le transport
    // Node relit le flux de la requête via @hono/node-server. Consommer
    // directement req.json() verrouillerait le ReadableStream et provoquerait
    // un crash asynchrone "ReadableStream is locked" après la réponse.
    let body: unknown;
    try {
        body = await req.clone().json();
    } catch {
        return jsonRpcError(400, -32700, "Parse error: invalid JSON body");
    }

    const {req: nodeReq, res: nodeRes} = toReqRes(req);

    const server = buildServer(appConfig);
    const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
    });

    nodeRes.on("close", () => {
        void transport.close();
        void server.close();
    });

    await server.connect(transport);
    await transport.handleRequest(nodeReq, nodeRes, body);

    return toFetchResponse(nodeRes);
};

export const config: Config = {
    path: "/mcp",
};
