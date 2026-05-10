#!/usr/bin/env node

import type {Server} from "node:http";
import type {StreamableHTTPServerTransport} from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {loadConfig} from "./config.js";
import {logger} from "./logger.js";
import {MailClient} from "./mail-client.js";
import {createApp} from "./http-server.js";

function installShutdownHandlers(
    httpServer: Server,
    transports: Map<string, StreamableHTTPServerTransport>,
): void {
    let shuttingDown = false;
    const shutdown = async (signal: string) => {
        if (shuttingDown) return;
        shuttingDown = true;
        logger.info({signal}, "shutting down");

        httpServer.close((err) => {
            if (err) logger.error({err}, "error closing HTTP server");
        });

        await Promise.allSettled(
            Array.from(transports.values()).map((t) => t.close()),
        );

        setTimeout(() => process.exit(0), 1000).unref();
    };

    process.on("SIGTERM", () => void shutdown("SIGTERM"));
    process.on("SIGINT", () => void shutdown("SIGINT"));
}

async function main(): Promise<void> {
    const config = loadConfig();

    const mailClient = new MailClient(config.mailToken);
    await mailClient.init();
    logger.info("Infomaniak MailClient initialized");

    const {app, transports} = createApp(config, mailClient);

    const httpServer = app.listen(config.port, config.host, () => {
        logger.info(
            {host: config.host, port: config.port},
            "MCP HTTP server listening",
        );
    });

    installShutdownHandlers(httpServer, transports);
}

main().catch((error) => {
    logger.error({err: error}, "Fatal error in main()");
    process.exit(1);
});
