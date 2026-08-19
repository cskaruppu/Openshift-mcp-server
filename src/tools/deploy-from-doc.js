/**
 * MCP Tool: deploy_from_document
 * Registers the document-driven deployment tool in the MCP server.
 */

import { z } from "zod";
import { parseDocx, parseMarkdownText } from "../services/doc-parser.js";
import { extractAIS } from "../services/ais-extractor.js";
import { generateManifests, renderYaml } from "../services/manifest-generator.js";
import { createDeployment, executeDeployment, rollbackDeployment, getDeploymentAnywhere, listDeploymentsAnywhere } from "../services/deployment-orchestrator.js";

export function registerDeployFromDocTools(server) {
  server.tool(
    "deploy_from_document",
    "Parse a document (Word or text) describing an application, extract deployment intent, generate Kubernetes/OpenShift manifests, and deploy",
    {
      action: z.enum(["parse", "preview", "deploy", "status", "rollback", "list"]).describe("Action to perform"),
      document: z.string().optional().describe("Base64-encoded .docx file content or plain-text deployment spec"),
      deployId: z.string().optional().describe("Deployment ID (for status/rollback)"),
      format: z.enum(["docx", "text"]).optional().default("text").describe("Input format"),
    },
    async ({ action, document, deployId, format }) => {
      switch (action) {
        case "parse": {
          if (!document) return { content: [{ type: "text", text: "Error: document is required for parse action" }] };
          const parsed = format === "docx"
            ? await parseDocx(Buffer.from(document, "base64"))
            : parseMarkdownText(document);
          const { intent, missingFields, confidence } = await extractAIS(parsed);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ intent, missingFields, confidence }, null, 2),
              },
            ],
          };
        }
        case "preview": {
          if (!document) return { content: [{ type: "text", text: "Error: document is required for preview action" }] };
          const parsed = format === "docx"
            ? await parseDocx(Buffer.from(document, "base64"))
            : parseMarkdownText(document);
          const { intent, missingFields } = await extractAIS(parsed);
          if (missingFields.length > 0) {
            return { content: [{ type: "text", text: "Missing fields:\n" + missingFields.join("\n") }] };
          }
          const { manifests, summary } = generateManifests(intent);
          const yamlOutput = renderYaml(manifests);
          return { content: [{ type: "text", text: `## Deployment Preview\n\n${JSON.stringify(summary, null, 2)}\n\n\`\`\`yaml\n${yamlOutput}\n\`\`\`` }] };
        }
        case "deploy": {
          if (!document) return { content: [{ type: "text", text: "Error: document is required for deploy action" }] };
          const parsed = format === "docx"
            ? await parseDocx(Buffer.from(document, "base64"))
            : parseMarkdownText(document);
          const { intent } = await extractAIS(parsed);
          const { manifests } = generateManifests(intent);
          const depId = createDeployment(intent, manifests);
          const result = await executeDeployment(depId);
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        }
        case "status": {
          const dep = await getDeploymentAnywhere(deployId);
          if (!dep) return { content: [{ type: "text", text: "Deployment not found" }] };
          return { content: [{ type: "text", text: JSON.stringify(dep, null, 2) }] };
        }
        case "rollback": {
          const result = await rollbackDeployment(deployId);
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        }
        case "list": {
          return { content: [{ type: "text", text: JSON.stringify(await listDeploymentsAnywhere(20), null, 2) }] };
        }
        default:
          return { content: [{ type: "text", text: "Unknown action: " + action }] };
      }
    }
  );
}
