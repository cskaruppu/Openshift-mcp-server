# UC-17 — ServiceNow Agent

**TCS Agentic AI for Hybrid Infrastructure · ITSM**

> *ServiceNow and OpenShift in one place: incidents correlated and deduplicated,
> change requests raised, tracked and closed with evidence.*

## 1. Summary

| Field | Value |
|---|---|
| Use case ID | UC-17 |
| Name | ServiceNow Agent (ITSM & Change Management) |
| Where | Automation Hub → ServiceNow Agent · used by UC-02, UC-05, UC-07, UC-10, UC-14, UC-15 |
| Trigger | Human-initiated (triage) and automatic (raised by other use cases) |
| Input | Open ServiceNow incidents and change requests; platform findings |
| Output | Correlated incident groups, linked and closed duplicates, change requests with reports, approval status |
| Prerequisite | ServiceNow instance URL and credentials configured on the hub |

## 2. The problem

One cluster fault produces many tickets, change requests are written by hand
and chased for approval, and closed tickets lack the evidence auditors ask for.

## 3. What it does

1. Shows the open incidents raised by the platform, groups those caused by the same condition, and links and closes the duplicates (the platform's own; never a ticket a person raised).
2. Raises incidents and change requests from other use cases, with HTML/PDF reports attached and the risk, rollback and implementation plans filled in.
3. Polls change requests for approval and lets the waiting use case continue only when approved; cancels its record if the change is deleted in ServiceNow.
4. Queries and updates ServiceNow records in plain language from AI Chat.

## 4. Business value

| Metric | Without | UC-17 |
|---|---|---|
| Duplicate incidents | One fault, many tickets | Grouped, linked, closed |
| Writing a change request | 1–2 hours | Seconds, evidence attached |
| Approval follow-up | Chasing by hand | Polled automatically |

## 5. Implementation map

| Part | Where |
|---|---|
| ServiceNow client | `src/utils/servicenow-client.js` |
| Incident correlation and duplicates | `src/services/incident-orchestrator.js` |
| Change tracking | `src/services/cr-tracker.js` |
| Agent manifest | `src/agents/manifests/itsm-change-management.json` |
| Console | `console/src/components/AutomationHub.jsx` (ServiceNow Agent) |

## 6. Verification status

| Claim | Status |
|---|---|
| Change request raised on deploy | ✅ Live in the lab (UC-07) |
| Duplicate handling and closure | ✅ Harness-verified as part of UC-05 |
| First auto-raise and close on a customer instance | 🔶 To be run live |

## 7. Related

UC-05 (closes its own tickets) · UC-02 and UC-10 (approval gates) · UC-15 (change with simulation report).
