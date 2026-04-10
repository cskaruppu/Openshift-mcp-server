import { z } from "zod";
import {
  createIncident,
  createChangeRequest,
  getRecord,
  queryRecords,
  updateRecord,
} from "../utils/servicenow-client.js";

export function registerServiceNowTools(server) {
  // ---------- Create Incident ----------
  server.tool(
    "create_servicenow_incident",
    "Create an incident in ServiceNow for a detected OpenShift issue",
    {
      shortDescription: z
        .string()
        .describe("Short description of the incident"),
      description: z
        .string()
        .describe(
          "Detailed description including cluster, namespace, pod, and issue details"
        ),
      urgency: z
        .enum(["1", "2", "3"])
        .optional()
        .default("2")
        .describe("Urgency: 1=High, 2=Medium, 3=Low"),
      impact: z
        .enum(["1", "2", "3"])
        .optional()
        .default("2")
        .describe("Impact: 1=High, 2=Medium, 3=Low"),
      category: z
        .string()
        .optional()
        .default("Infrastructure")
        .describe("Category of the incident"),
      assignmentGroup: z
        .string()
        .optional()
        .describe("Assignment group for the incident"),
    },
    async ({
      shortDescription,
      description,
      urgency,
      impact,
      category,
      assignmentGroup,
    }) => {
      try {
        const result = await createIncident({
          shortDescription,
          description,
          urgency,
          impact,
          category,
          assignmentGroup,
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  status: "created",
                  incidentNumber: result.result?.number,
                  sysId: result.result?.sys_id,
                  state: result.result?.state,
                  message: `Incident ${result.result?.number} created successfully in ServiceNow.`,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // ---------- Create Change Request ----------
  server.tool(
    "create_change_request",
    "Create a change request in ServiceNow for an OpenShift remediation action that requires approval",
    {
      shortDescription: z
        .string()
        .describe("Short description of the change"),
      description: z
        .string()
        .describe(
          "Detailed description of the change, impact, and rollback plan"
        ),
      type: z
        .enum(["normal", "standard", "emergency"])
        .optional()
        .default("normal")
        .describe("Change type"),
      priority: z
        .enum(["1", "2", "3", "4"])
        .optional()
        .default("3")
        .describe("Priority: 1=Critical, 2=High, 3=Moderate, 4=Low"),
      risk: z
        .enum(["high", "moderate", "low"])
        .optional()
        .default("moderate")
        .describe("Risk level"),
      assignmentGroup: z
        .string()
        .optional()
        .describe("Assignment group for the change"),
      justification: z
        .string()
        .optional()
        .describe("Business justification for the change"),
    },
    async ({
      shortDescription,
      description,
      type,
      priority,
      risk,
      assignmentGroup,
      justification,
    }) => {
      try {
        const result = await createChangeRequest({
          shortDescription,
          description,
          type,
          priority,
          risk,
          assignmentGroup,
          justification,
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  status: "created",
                  changeNumber: result.result?.number,
                  sysId: result.result?.sys_id,
                  state: result.result?.state,
                  type,
                  message: `Change Request ${result.result?.number} created. ${
                    type === "emergency"
                      ? "Emergency change — expedited approval."
                      : "Awaiting approval."
                  }`,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // ---------- Check Approval Status ----------
  server.tool(
    "check_approval_status",
    "Check if a ServiceNow change request has been approved",
    {
      changeRequestId: z
        .string()
        .describe("Sys ID or change number to check"),
    },
    async ({ changeRequestId }) => {
      try {
        let result;
        // If it looks like a sys_id (32-char hex), query directly
        if (/^[a-f0-9]{32}$/.test(changeRequestId)) {
          result = await getRecord("change_request", changeRequestId);
        } else {
          // Query by number
          const records = await queryRecords(
            "change_request",
            `number=${changeRequestId}`
          );
          result = { result: records.result?.[0] };
        }

        const cr = result.result;
        const stateMap = {
          "-5": "New",
          "-4": "Assess",
          "-3": "Authorize",
          "-2": "Scheduled",
          "-1": "Implement",
          0: "Review",
          3: "Closed",
          4: "Cancelled",
        };

        const approvalMap = {
          not_requested: "Not Requested",
          requested: "Requested",
          approved: "Approved",
          rejected: "Rejected",
        };

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  changeNumber: cr?.number,
                  state: stateMap[cr?.state] || cr?.state,
                  approval: approvalMap[cr?.approval] || cr?.approval,
                  isApproved: cr?.approval === "approved",
                  shortDescription: cr?.short_description,
                  assignedTo: cr?.assigned_to?.display_value,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // ---------- Query ServiceNow Records ----------
  server.tool(
    "query_servicenow",
    "Query ServiceNow records (incidents, changes, problems) with filters",
    {
      table: z
        .string()
        .describe("ServiceNow table name: incident, change_request, problem"),
      query: z
        .string()
        .describe(
          "Encoded query string, e.g. short_descriptionLIKEopenshift^state=1"
        ),
      limit: z.number().optional().default(10).describe("Max records to return"),
    },
    async ({ table, query, limit }) => {
      try {
        const result = await queryRecords(table, query, limit);
        const records = (result.result || []).map((r) => ({
          number: r.number,
          sysId: r.sys_id,
          shortDescription: r.short_description,
          state: r.state,
          priority: r.priority,
          assignedTo: r.assigned_to?.display_value,
          createdOn: r.sys_created_on,
          updatedOn: r.sys_updated_on,
        }));

        return {
          content: [
            { type: "text", text: JSON.stringify(records, null, 2) },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // ---------- Update ServiceNow Record ----------
  server.tool(
    "update_servicenow_record",
    "Update a ServiceNow record (e.g., close an incident, add work notes)",
    {
      table: z.string().describe("Table name"),
      sysId: z.string().describe("Sys ID of the record"),
      data: z
        .record(z.string())
        .describe(
          "Key-value pairs to update, e.g. {state: '6', close_code: 'Resolved'}"
        ),
    },
    async ({ table, sysId, data }) => {
      try {
        const result = await updateRecord(table, sysId, data);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  status: "updated",
                  number: result.result?.number,
                  sysId: result.result?.sys_id,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );
}
