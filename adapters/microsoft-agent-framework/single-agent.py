"""
Pattern A — Single Microsoft Agent Framework agent connected to the full
TCS Agentic AI MCP server (all 12 specialist agents and 162 tools).

Run:
    pip install -r requirements.txt
    az login
    export FOUNDRY_PROJECT_ENDPOINT="https://your-project.services.ai.azure.com/api/projects/your-project"
    export FOUNDRY_MODEL="gpt-4o-mini"
    export TCS_AGENTIC_URL="https://agentic-ai-server-openshift-mcp.apps.openshift.caaslab.local"
    python single-agent.py
"""

import asyncio
import os

from agent_framework import Agent
from agent_framework.foundry import FoundryChatClient
from azure.identity.aio import AzureCliCredential
from dotenv import load_dotenv


async def main() -> None:
    load_dotenv()

    tcs_url = os.environ["TCS_AGENTIC_URL"].rstrip("/")
    tcs_bearer = os.getenv("TCS_AGENTIC_BEARER")  # optional

    auth_headers = {}
    if tcs_bearer:
        auth_headers["Authorization"] = f"Bearer {tcs_bearer}"

    async with AzureCliCredential() as credential:
        client = FoundryChatClient(
            project_endpoint=os.environ["FOUNDRY_PROJECT_ENDPOINT"],
            model=os.environ.get("FOUNDRY_MODEL", "gpt-4o-mini"),
            credential=credential,
        )

        # Connect to the FULL TCS Agentic AI MCP server (all 162 tools).
        # The MS Agent Framework will auto-discover every tool exposed.
        tcs_full = client.get_mcp_tool(
            name="TCS Agentic AI (Full)",
            url=f"{tcs_url}/sse",
            headers=auth_headers,
            approval_mode="never_require",
        )

        async with Agent(
            client=client,
            name="OpenShiftAssistant",
            instructions=(
                "You are an enterprise OpenShift assistant. Use the TCS Agentic AI "
                "tools to inspect clusters, diagnose pod issues, run upgrade preflight "
                "assessments, manage ServiceNow change requests, and orchestrate fixes. "
                "Always confirm risky actions before executing them."
            ),
            tools=[tcs_full],
        ) as agent:
            queries = [
                "List the namespaces in the cluster.",
                "Diagnose any pods currently in CrashLoopBackOff in the postgres namespace.",
                "Run a pre-upgrade preflight assessment for OCP 4.19.24.",
            ]
            for q in queries:
                print(f"\n>>> {q}")
                result = await agent.run(q)
                print(result.text)


if __name__ == "__main__":
    asyncio.run(main())
