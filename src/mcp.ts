// Minimal client for the Pharos Chain MCP server (Streamable HTTP transport).
// Hosted endpoint per docs.pharos.xyz/tooling-and-infrastructure/mcp: https://mcp.pharos.xyz/mcp
// NOTE: the hosted server is configured for Pacific mainnet (chainId 1672). For Atlantic testnet,
// self-host pharos-mcp with PHAROS_RPC_URL/PHAROS_CHAIN_ID pointing at Atlantic, or use RPC directly.

export class McpClient {
  private session: string | null = null;
  private id = 0;
  constructor(private url: string) {}

  private async post(body: unknown): Promise<any> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
    if (this.session) headers['mcp-session-id'] = this.session;
    const res = await fetch(this.url, { method: 'POST', headers, body: JSON.stringify(body) });
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.session = sid;
    const text = await res.text();
    if (!res.ok) throw new Error(`MCP HTTP ${res.status}: ${text.slice(0, 200)}`);
    if (!text) return null;
    // Streamable HTTP may answer with SSE frames; take the last JSON data frame.
    if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
      const datas = text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim());
      return datas.length ? JSON.parse(datas[datas.length - 1]) : null;
    }
    return JSON.parse(text);
  }

  async init(): Promise<any> {
    const r = await this.post({
      jsonrpc: '2.0',
      id: ++this.id,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'pharos-sponsor-desk', version: '0.1.0' } },
    });
    await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' }).catch(() => null);
    return r?.result;
  }

  async listTools(): Promise<string[]> {
    const r = await this.post({ jsonrpc: '2.0', id: ++this.id, method: 'tools/list', params: {} });
    return (r?.result?.tools ?? []).map((t: any) => t.name);
  }

  async call(name: string, args: Record<string, unknown> = {}): Promise<any> {
    const r = await this.post({ jsonrpc: '2.0', id: ++this.id, method: 'tools/call', params: { name, arguments: args } });
    if (r?.error) throw new Error(`MCP error: ${JSON.stringify(r.error)}`);
    const content = r?.result?.content ?? [];
    const txt = content.map((c: any) => c.text ?? '').join('\n');
    try {
      return JSON.parse(txt);
    } catch {
      return txt;
    }
  }
}
