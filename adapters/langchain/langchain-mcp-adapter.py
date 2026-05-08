"""
LangChain + TCS Agentic AI via the MCP adapter.

Run:
    pip install langchain langchain-anthropic langchain-mcp-adapters
    export ANTHROPIC_API_KEY=...
    export TCS_AGENTIC_URL="https://mcp-server-openshift-mcp.apps.openshift.caaslab.local"
    python langchain-mcp-adapter.py
"""

import asyncio
import os

from langchain_anthropic import ChatAnthropic
from langchain.agents import AgentExecutor, create_tool_calling_agent
from langchain_core.prompts import ChatPromptTemplate
from langchain_mcp_adapters.client import MultiServerMCPClient


async def main() -> None:
    tcs_url = os.environ["TCS_AGENTIC_URL"].rstrip("/")
    bearer = os.getenv("TCS_AGENTIC_BEARER")
    headers = {"Authorization": f"Bearer {bearer}"} if bearer else {}

    # Connect LangChain to multiple TCS specialist agents.
    # Add or remove entries to scope the LLM's tool surface.
    mcp_client = MultiServerMCPClient(
        {
            "diagnostics": {
                "url": f"{tcs_url}/mcp/diagnostics-healing/sse",
                "transport": "sse",
                "headers": headers,
            },
            "upgrade": {
                "url": f"{tcs_url}/mcp/upgrade-lifecycle/sse",
                "transport": "sse",
                "headers": headers,
            },
            "itsm": {
                "url": f"{tcs_url}/mcp/itsm-change-management/sse",
                "transport": "sse",
                "headers": headers,
            },
        }
    )

    tools = await mcp_client.get_tools()
    print(f"Loaded {len(tools)} tools from TCS Agentic AI specialists")

    llm = ChatAnthropic(model="claude-opus-4-7", temperature=0)
    prompt = ChatPromptTemplate.from_messages(
        [
            ("system", "You are an OpenShift SRE assistant powered by TCS Agentic AI."),
            ("human", "{input}"),
            ("placeholder", "{agent_scratchpad}"),
        ]
    )
    agent = create_tool_calling_agent(llm, tools, prompt)
    executor = AgentExecutor(agent=agent, tools=tools, verbose=True)

    result = await executor.ainvoke(
        {
            "input": (
                "Run a pre-upgrade preflight assessment for OCP 4.19.24, "
                "and if it's READY, raise a ServiceNow change request."
            )
        }
    )
    print(result["output"])


if __name__ == "__main__":
    asyncio.run(main())
