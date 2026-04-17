import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { FounderOSApiClient } from "./client.js";
import { readConfigFromEnv, type FounderOSMcpConfig } from "./config.js";
import { createToolDefinitions } from "./tools.js";

export function createFounderOSMcpServer(config: FounderOSMcpConfig = readConfigFromEnv()) {
  const server = new McpServer({
    name: "founderos",
    version: "0.1.0",
  });

  const client = new FounderOSApiClient(config);
  const tools = createToolDefinitions(client);
  for (const tool of tools) {
    server.tool(tool.name, tool.description, tool.schema.shape, tool.execute);
  }

  return {
    server,
    tools,
    client,
  };
}

export async function runServer(config: FounderOSMcpConfig = readConfigFromEnv()) {
  const { server } = createFounderOSMcpServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
