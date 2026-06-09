"""
Pattern B — Multi-agent orchestrator (RECOMMENDED for production)

One Microsoft Agent Framework agent per TCS specialist. Each MS agent connects
to the corresponding per-agent MCP endpoint, so its tool surface is small and
focused. An orchestrator routes the user's intent to the right specialist.

This pattern gives you:
  - Audit trail (which specialist handled which request)
  - Smaller, faster prompts per specialist (no tool noise)
  - Selective deployment (customer enables only the agents they need)
  - Better explainability for compliance reviews

Run:
    pip install -r requirements.txt
    az login
    export FOUNDRY_PROJECT_ENDPOINT="https://your-project.services.ai.azure.com/api/projects/your-project"
    export FOUNDRY_MODEL="gpt-4o-mini"
    export TCS_AGENTIC_URL="https://agentic-ai-server-openshift-mcp.apps.openshift.caaslab.local"
    python multi-agent-orchestrator.py
"""

import asyncio
import os
from typing import Dict, List

import httpx
from agent_framework import Agent
from agent_framework.foundry import FoundryChatClient
from azure.identity.aio import AzureCliCredential
from dotenv import load_dotenv


async def discover_agents(base_url: str, headers: Dict[str, str]) -> List[dict]:
    """Pull the agent catalogue from the well-known agent card."""
    async with httpx.AsyncClient(verify=False, timeout=15) as http:
        resp = await http.get(f"{base_url}/.well-known/agent.json", headers=headers)
        resp.raise_for_status()
        return resp.json().get("agents", [])


def build_specialist_instructions(agent_meta: dict) -> str:
    return (
        f"You are the TCS {agent_meta['name']}. "
        f"{agent_meta['description']} "
        "Use only the tools available to you. Be concise. "
        "If the user's request belongs to a different specialist, say so explicitly."
    )


async def main() -> None:
    load_dotenv()

    tcs_url = os.environ["TCS_AGENTIC_URL"].rstrip("/")
    tcs_bearer = os.getenv("TCS_AGENTIC_BEARER")
    auth_headers = {"Authorization": f"Bearer {tcs_bearer}"} if tcs_bearer else {}

    async with AzureCliCredential() as credential:
        client = FoundryChatClient(
            project_endpoint=os.environ["FOUNDRY_PROJECT_ENDPOINT"],
            model=os.environ.get("FOUNDRY_MODEL", "gpt-4o-mini"),
            credential=credential,
        )

        # Discover available specialists from the TCS server's agent card.
        agent_catalogue = await discover_agents(tcs_url, auth_headers)
        print(f"Discovered {len(agent_catalogue)} TCS specialist agents")

        # Build one MS Agent Framework agent per specialist.
        specialists = []
        for meta in agent_catalogue:
            mcp_tool = client.get_mcp_tool(
                name=meta["name"],
                url=f"{tcs_url}/mcp/{meta['id']}/sse",
                headers=auth_headers,
                approval_mode="never_require",
            )
            specialist = client.as_agent(
                name=meta["id"].replace("-", "_"),
                description=meta["description"],
                instructions=build_specialist_instructions(meta),
                tools=[mcp_tool],
            )
            specialists.append(specialist)
            print(f"  - {meta['name']} ({meta['toolCount']} tools)")

        # Orchestrator agent — uses the specialists as function tools.
        # MS Agent Framework converts each agent into a callable tool via
        # .as_tool(); the orchestrator picks the right specialist per query.
        orchestrator_tools = [s.as_tool() for s in specialists]

        async with Agent(
            client=client,
            name="TCS_Agentic_AI_Orchestrator",
            instructions=(
                "You are the TCS Agentic AI orchestrator. You coordinate 12 specialist "
                "agents covering cluster operations, workloads, diagnostics, upgrades, "
                "ITSM (ServiceNow), security, networking, CI/CD, observability, "
                "infrastructure, proactive intelligence, and multi-cluster (ACM). "
                "Route each user request to the most relevant specialist; if multiple "
                "are needed, call them in sequence and aggregate the result. Always "
                "name the specialist you are using so the user can audit which "
                "subsystem produced each answer."
            ),
            tools=orchestrator_tools,
        ) as orchestrator:
            queries = [
                "Diagnose CrashLoopBackOff pods in the postgres namespace.",
                "Run a pre-upgrade assessment to OCP 4.19.24 and create a ServiceNow CR.",
                "Show me the firing alerts and identify which deployments are affected.",
            ]
            for q in queries:
                print(f"\n>>> {q}")
                result = await orchestrator.run(q)
                print(result.text)


if __name__ == "__main__":
    asyncio.run(main())
