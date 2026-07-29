# Contributing to TCS Agentic AI

Thank you for your interest in contributing! This guide will help you get started.

## Prerequisites

- Node.js >= 18
- Access to an OpenShift / Kubernetes cluster (or `oc`/`kubectl` configured)
- `KUBECONFIG` environment variable pointing to a valid kubeconfig

## Getting Started

```bash
git clone https://github.com/cskaruppu/openshift-mcp-server.git
cd openshift-mcp-server
npm install
npm run dev
```

The server starts on port `3001` by default (override with `PORT`).

## Project Structure

```
src/
  index.js              # Entry point — HTTP server, SSE transport, route handlers
  tools/                # MCP tool modules (one file per domain)
    cluster.js          # Cluster-level operations
    nodes.js            # Node inspection, kubelet/CRI-O checks
    pods.js             # Pod lifecycle
    workloads.js        # Deployments, StatefulSets, DaemonSets
    provisioning.js     # Deployment/database/HPA/service creation
    benchmarks.js       # Performance benchmark tools
    diagnostics.js      # Cluster diagnostics
    ...
  services/             # Business logic (chat, auth, action workflow, etc.)
  utils/                # Shared utilities (OpenShift client, config, DB, cache)
dashboard/
  index.html            # Single-page dashboard UI
examples/               # Client configs, sample requirements, SOPs, applications
docs/                   # Architecture documentation
```

## Adding a New Tool

1. Create or open the appropriate file under `src/tools/`.
2. Export a `registerXxxTools(server)` function.
3. Use `server.tool(name, description, zodSchema, handler)` to register tools.
4. Import and call the register function in `src/index.js` inside `createMcpServer()`.

Example:

```javascript
import { z } from "zod";
import { ocpGet } from "../utils/openshift-client.js";

export function registerMyTools(server) {
  server.tool(
    "my_tool_name",
    "What this tool does",
    {
      param: z.string().describe("Parameter description"),
    },
    async ({ param }) => {
      const data = await ocpGet(`/api/v1/...`);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    }
  );
}
```

## API Client

All OpenShift/Kubernetes API calls go through `src/utils/openshift-client.js`:

- `ocpGet(path)` — GET request
- `ocpPost(path, body)` — POST (create)
- `ocpPatch(path, body)` — PATCH (update)
- `ocpDelete(path)` — DELETE
- `ocpFetch(path, options)` — Raw fetch with custom headers

The client reads `KUBECONFIG` or in-cluster credentials automatically.

## Code Style

- ES modules (`import`/`export`)
- Minimal comments — only when the "why" is non-obvious
- Consistent error handling: return `{ content: [...], isError: true }`
- Use `zod` schemas for all tool parameters

## Testing

```bash
npm test
```

Tests live under `test/`:

| Folder | Contents | Command |
|---|---|---|
| `test/unit/` | Unit tests | `npm test` |
| `test/smoke/` | End-to-end smoke test | `npm run test:smoke` |
| `test/evals/` | Prompt/behaviour evals | `npm run evals` |
| `test/fixtures/` | Shared fixtures and test manifests | — |

Add tests for new tools as `test/unit/<tool-name>.test.js`.

## Commit Messages

- Use imperative mood: "Add storage benchmark tool" not "Added..."
- Keep the first line under 72 characters
- Reference issues when applicable: "Fix node log retrieval (#42)"

## Pull Request Process

1. Fork the repository and create a feature branch
2. Make your changes with clear commit messages
3. Ensure `npm test` passes
4. Open a PR against `main` with a description of what changed and why
