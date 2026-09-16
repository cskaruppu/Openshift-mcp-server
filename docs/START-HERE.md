# Start here

**"How do we deploy these agents?"** is four different questions wearing one
sentence, and the answer to three of them is: *you don't deploy anything.*

Find your row. Each one ends in something you can run.

| You want to… | Go to |
|---|---|
| **Use these agents** from your app, IDE or framework | [1 — Connect](#1--connect-to-an-agent) |
| **Get your cluster managed** by the platform | [2 — Connect a cluster](#2--connect-a-cluster) |
| **Build an agent** that lives in this registry | [3 — Build an agent](#3--build-an-agent) |
| **Plug in an MCP server you already run** | [4 — Connect your own server](#4--connect-your-own-server) |

Most people are row 1. That is a URL and a token.

---

## First, the thing that trips everyone up

**An agent here is not a deployable.** All sixteen run inside one MCP server
process; an agent is a named subset of that server's tools with its own
endpoint. There is no container per agent, no Helm chart per agent, nothing to
install.

If you were planning to "deploy the VM Migration Agent" into your own cluster,
stop — that is not a thing, and the reason row 1 is so short is that the work is
already done and running.

---

## 1 — Connect to an agent

**Deploy nothing.** You need two things: the agent's URL, and a token.

1. Open the console → the **Agent Registry** icon in the header.
2. Click the agent you want.
3. Under **Use it — paste this**, pick your language and copy.

That panel is pre-filled with that agent's real URL and one of its real tools,
so it runs as pasted.

If you would rather not open the console:

```bash
# Every agent, with its connectable URL
curl -s -H "Authorization: Bearer $MCP_API_TOKEN" \
  https://<your-console-host>/api/agents | jq '.agents[] | {id, name, mcpSseUrl}'
```

**Getting a token:** ask whoever administers the console. If that is a slow
path in your organisation, say so — it is the most common reason a team decides
it needs its own copy of the platform, and a copy is worse for everyone than a
token.

**Pick two or three agents, not all sixteen.** Registering every agent puts
189 tool definitions in front of the model at once. It works, and selection
quality drops as the list grows.

Fuller reference, including Microsoft Agent Framework and the full tool
listings: [`AGENT-CATALOG.md`](AGENT-CATALOG.md).

---

## 2 — Connect a cluster

This is the one row that *does* deploy something — but what you deploy is **one
agent pod** that connects your cluster back to the hub, not the agents
themselves.

1. Console → cluster picker → **Connect a Cluster**.
2. Fill in name and API endpoint; it detects the platform.
3. It generates the YAML and a one-line command. Apply it as cluster-admin.
4. The card turns **Active** within about a minute.

What gets created: a namespace, ServiceAccount, ClusterRole and binding, a
Deployment, a Service, and a Route on OpenShift. It is cluster-side only — no
image rebuild.

Scripted instead: `deploy/mcp/deploy.sh --cluster-name <name>`.

---

## 3 — Build an agent

**No deployment — a pull request.**

1. Console → Agent Registry → **Catalog** → **+ New agent**.
2. Fill in id, name, description; pick tools from the list of what this server
   actually serves.
3. Press **Check and generate**.

It validates and shows the **grade the agent will be born with**. Filling in
owner, trust tier, blast radius and autonomy typically moves it from E to B —
that is worth doing at creation, because nobody audits their way back to it
later.

4. Commit the generated file to `src/agents/manifests/<id>.json`.

Two things to know before you start:

- **You can only declare tools that exist.** The form lists what the server
  serves and refuses anything else. Twenty-four tools across the existing
  manifests were declared and never implemented — clients connecting to those
  agents get an empty list and no error. The check exists so it does not happen
  again.
- **A new agent starts on probation.** It is `experimental`, not selectable by
  default, and reachable by you for testing. Use **Request promotion** when it
  is ready; that raises a change request, and somebody other than you approves
  it.

---

## 4 — Connect your own server

Already run an MCP server? It can join this registry without moving.

1. Console → Agent Registry → **Catalog** → **+ Connect an external agent**.
2. Give it a name, pick the transport (SSE, Streamable HTTP, or stdio), and
   provide the URL or command.
3. Declare its **trust tier** and **blast radius**.

That third step is not paperwork. An external agent is code outside your supply
chain running against your estate; declaring what it may do is the whole basis
on which anyone can be comfortable with it. Anything you leave undeclared stays
undeclared, and the agent shows as **unreviewed** until somebody fills it in.

Its tools cannot shadow a built-in — dispatch resolves built-ins first.

---

## Where to go next

| Question | Where |
|---|---|
| What can this agent actually do? | Agent Registry → the agent → Capabilities and Tools |
| Who owns it, and is it behaving? | Agent Registry → **Governance** |
| Every endpoint, every tool, every framework | [`AGENT-CATALOG.md`](AGENT-CATALOG.md) |
| The same, as a spreadsheet | `TCS-Agentic-AI-Agent-Catalog.xlsx` |

---

*This page exists to get you to the right one of four answers in ten seconds.
It is deliberately not a reference — when you need one, `AGENT-CATALOG.md` is
the reference.*
