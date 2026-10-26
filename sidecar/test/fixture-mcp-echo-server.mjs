/**
 * Test fixture: minimal MCP stdio server (STABLE SDK) with one `echo` tool.
 * Spawned by test/mcp-skills.test.ts via StdioClientTransport.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema, CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const server = new Server({ name: 'echo-fixture', version: '0.1.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: 'echo',
    description: 'Echo back the input text',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  }],
}));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name !== 'echo') throw new Error(`unknown tool ${req.params.name}`);
  return { content: [{ type: 'text', text: `echo:${req.params.arguments?.text}` }] };
});
await server.connect(new StdioServerTransport());
