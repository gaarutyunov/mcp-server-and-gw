#!/usr/bin/env node
import { EventSource } from "eventsource";

// Get the backend URL from command line arg or environment variables
let baseUrl: string;

if (process.argv.length > 2) {
  baseUrl = process.argv[2];
  if (!baseUrl.startsWith("http://") && !baseUrl.startsWith("https://")) {
    baseUrl = `http://${baseUrl}`;
  }
  // Remove trailing slash if present
  if (baseUrl.endsWith("/")) {
    baseUrl = baseUrl.slice(0, -1);
  }
} else {
  const MCP_HOST = process.env["MCP_HOST"] ?? "localhost";
  const MCP_PORT = process.env["MCP_PORT"] ?? 8808;
  baseUrl = `http://${MCP_HOST}:${MCP_PORT}`;
}

const backendUrlSse = `${baseUrl}/sse`;
let backendUrlMsg = `${baseUrl}/message`;

// Extract custom headers from environment variables
function getCustomHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  
  for (const [key, value] of Object.entries(process.env)) {
    if (key.toUpperCase().startsWith('MCP_HEADER_') && value) {
      const headerKey = key.substring('MCP_HEADER_'.length).toLowerCase();
      headers[headerKey] = value;
    }
  }
  
  return headers;
}

// Store custom headers
const customHeaders = getCustomHeaders();

const debug = console.error; // With stdio transport stderr is the only channel for debugging
const respond = console.log; // Message back to Claude Desktop App.

/*
 * Claude MCP has two communications channels.
 * 1. All the responses (and notifications) from the MCP server comes through the
 *    persistent HTTP connection (i.e. Server-Side Events).
 * 2. However, the requests are sent as HTTP POST messages and for which the server
 *    responds HTTP 202 Accept (the "actual" response is sent through the SSE connection)
 */

let connected = false;
let queue: Buffer[] = [];

// 1. Establish persistent MCP server SSE connection and forward received messages to stdin
function connectSSEBackend() {
  connected = false;
  queue = [];
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("SSE Backend Connection timeout")), 10_000);
    const source = new EventSource(backendUrlSse, {
      fetch: (input, init) =>
        fetch(input, {
          ...init,
          headers: {
            ...init?.headers,
            ...customHeaders,
          },
        }),
    });
    source.onopen = (evt: Event) => resolve(clearTimeout(timer));
    source.addEventListener("endpoint", (e) => {
      // Extract base URL without path and query parameters
      const urlObj = new URL(baseUrl);
      backendUrlMsg = e.data;
      debug(`--- SSE backend sent "endpoint" event (${e.data}) ==> Setting message endpoint URL: "${backendUrlMsg}"`);
      connected = true;
      resolve(clearTimeout(timer));
    });
    source.addEventListener("error", (e) => reject(e));
    source.addEventListener("message", (e) => respond(e.data)); // forward to Claude Desktop App via stdio transport
    source.addEventListener("message", (e) => debug(`<-- ${e.data}`));
    source.addEventListener("open", (e) => debug(`--- SSE backend connected`));
    source.addEventListener("error", (e) => debug(`--- SSE backend disc./error: ${(<any>e)?.message}`));
  });
}

// 2. Forward received message to the MCP server
async function processMessage(inp: Buffer) {
  if (!connected) {
    queue.push(inp);
    return;
  }
  const msg = inp.toString();
  debug("-->", msg.trim());
  const [method, body] = ["POST", msg];
  const resp = await fetch(new URL(backendUrlMsg), { method, body, headers: customHeaders }).catch((e) => debug("fetch error:", e));
  if (resp && !resp?.ok) debug(`HTTP error: ${resp.status} ${resp.statusText}`);
}

async function runBridge() {
  debug(`-- Connecting to MCP server at ${baseUrl}`);
  process.stdin.on("data", processMessage);
  process.stdin.on("end", () => {
    debug("-- stdin disconnected, exiting");
    process.exit(0);
  });
  await connectSSEBackend();
  queue.forEach(processMessage);
  queue = [];
  debug(`-- MCP stdio to SSE gateway running - connected to ${baseUrl}`);
}

runBridge().catch((error) => {
  debug("Fatal error running server:", error);
  process.exit(1);
});
