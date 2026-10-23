// Protocol fixture only; no real screenshots or input are synthesized by this file.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

if (process.argv[2] === 'permissions') {
  console.log(JSON.stringify({ success: true, data: { source: 'fixture', permissions: [{ name: 'Screen Recording', isRequired: true, isGranted: false }] } }));
} else {
  const server = new Server({ name: 'native-mac-fixture', version: '1.0.0' }, { capabilities: { tools: {} } });
  const schema = properties => ({ type: 'object', properties, additionalProperties: false });
  const tools = [
    { name: 'see', inputSchema: schema({ app_target: { type: 'string' }, path: { type: 'string' }, include_elements: { type: 'boolean' }, max_elements: { type: 'number' } }) },
    { name: 'image', inputSchema: schema({ format: { type: 'string' }, max_dimension: { type: 'number' } }) },
    { name: 'click', inputSchema: schema({ on: { type: 'string' }, snapshot: { type: 'string' } }) },
    { name: 'type', inputSchema: schema({ text: { type: 'string' }, snapshot: { type: 'string' } }) },
    { name: 'app', inputSchema: schema({ action: { type: 'string' }, all: { type: 'boolean' } }) },
    { name: 'agent', inputSchema: schema({}) }, { name: 'shell', inputSchema: schema({}) },
  ];
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  let count = 0;
  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const args = req.params.arguments ?? {};
    if (args.text === 'disconnect') { process.exit(0); }
    if (args.text === 'unverified') return { isError: true, _meta: { mutation_dispatched: true, state: 'dispatched_unverified', retry_safe: false }, content: [{ type: 'text', text: 'Input delivered but not verified.' }] };
    if (args.text === 'slow') await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 5000);
      extra.signal.addEventListener('abort', () => { clearTimeout(timer); reject(Error('canceled')); }, { once: true });
    });
    if (['see', 'image'].includes(req.params.name)) return { content: [{ type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB' }],
      _meta: { snapshot_id: 'snapshot-test', ui_elements: [{ id: 'button', role: 'AXButton' }] } };
    return { content: [{ type: 'text', text: JSON.stringify({ count: ++count, secretsInherited: Boolean(process.env.OPENAI_API_KEY), coords: args.coords }) }] };
  });
  await server.connect(new StdioServerTransport());
}
