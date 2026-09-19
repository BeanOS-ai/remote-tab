#!/usr/bin/env bun
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./index";

const serverUrl = process.env.REMOTE_TAB_SERVER_URL;
const apiKey = process.env.REMOTE_TAB_API_KEY;
if (!serverUrl) {
  console.error(
    "Set REMOTE_TAB_SERVER_URL to start remote-tab-mcp. REMOTE_TAB_API_KEY is optional.",
  );
  process.exit(1);
}
try {
  await createMcpServer({ serverUrl, apiKey }).connect(new StdioServerTransport());
} catch {
  console.error("remote-tab-mcp failed to start.");
  process.exit(1);
}
