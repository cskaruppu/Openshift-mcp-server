# LangChain Adapter — TCS Agentic AI

LangChain ships an MCP adapter (`langchain-mcp-adapters`) that consumes
any MCP server. Point it at TCS Agentic AI and the 162 tools — or any
single agent's filtered tool set — become LangChain tools automatically.

```bash
pip install langchain langchain-anthropic langchain-mcp-adapters
export ANTHROPIC_API_KEY=...
export TCS_AGENTIC_URL="https://agentic-ai-server-openshift-mcp.apps.openshift.caaslab.local"
python langchain-mcp-adapter.py
```

See [`langchain-mcp-adapter.py`](langchain-mcp-adapter.py).
