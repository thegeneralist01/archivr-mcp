#!/usr/bin/env bun
import { ArchivrApiError } from "./client/errors";
import { ArchivrClient } from "./client/http";
import { ConfigError, loadConfig } from "./config";
import { createLogger } from "./lib/log";
import { createServer, SERVER_NAME, SERVER_VERSION } from "./server";
import { serveStdio } from "./transport/stdio";

function fail(message: string, code: number): never {
  process.stderr.write(`${SERVER_NAME}: ${message}\n`);
  process.exit(code);
}

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) fail(error.message, 2);
    throw error;
  }

  const log = createLogger(config.logLevel, [config.token]);
  const client = new ArchivrClient({
    baseUrl: config.url,
    token: config.token,
    timeoutMs: config.timeoutMs,
    userAgent: `${SERVER_NAME}/${SERVER_VERSION}`,
  });

  let mcp;
  try {
    mcp = await createServer(config, client, { log });
  } catch (error) {
    if (error instanceof ArchivrApiError && error.status === 401) {
      fail(
        "Archivr rejected the API token (401). It is invalid, expired or revoked: create a new token in Archivr and update ARCHIVR_TOKEN.",
        1,
      );
    }
    fail(`failed to start (${error instanceof Error ? error.name : "unknown error"})`, 1);
  }

  log.info(`ready: ${mcp.toolNames.length} tools for ${mcp.me?.username ?? "unknown user"}`);
  await serveStdio(mcp.server);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    fail(`fatal: ${error instanceof Error ? error.name : "unknown error"}`, 1);
  });
}
