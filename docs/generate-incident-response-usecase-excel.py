#!/usr/bin/env python3
"""Generate TCS Agentic AI — Incident Response & Application Performance Troubleshooting Use Case Excel + HTML."""

from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter
import os

OUT_DIR = os.path.dirname(os.path.abspath(__file__))

wb = Workbook()

# ── Colours & Styles ──
PRIMARY = "1A1A2E"
ACCENT = "0F7DC2"
GREEN = "16A34A"
RED = "DC2626"
ORANGE = "E67E22"
WHITE = "FFFFFF"
LIGHT_BG = "F8FAFC"
LIGHT_GREEN = "F0FDF4"
LIGHT_RED = "FEF2F2"
LIGHT_BLUE = "EFF6FF"

hdr_font = Font(name="Inter", bold=True, color=WHITE, size=11)
hdr_fill = PatternFill("solid", fgColor=PRIMARY)
sub_hdr_font = Font(name="Inter", bold=True, color=WHITE, size=11)
accent_fill = PatternFill("solid", fgColor=ACCENT)
green_fill = PatternFill("solid", fgColor=GREEN)
red_fill = PatternFill("solid", fgColor=RED)
light_green_fill = PatternFill("solid", fgColor="DCFCE7")
light_red_fill = PatternFill("solid", fgColor="FEE2E2")
light_blue_fill = PatternFill("solid", fgColor="DBEAFE")
light_bg_fill = PatternFill("solid", fgColor=LIGHT_BG)
highlight_fill = PatternFill("solid", fgColor=LIGHT_GREEN)
bold = Font(name="Inter", bold=True, size=11)
bold_green = Font(name="Inter", bold=True, color=GREEN, size=11)
bold_red = Font(name="Inter", bold=True, color=RED, size=11)
bold_white = Font(name="Inter", bold=True, color=WHITE, size=12)
normal = Font(name="Inter", size=11)
small = Font(name="Inter", size=10, color="64748B")
wrap = Alignment(wrap_text=True, vertical="top")
center = Alignment(horizontal="center", vertical="center", wrap_text=True)
thin_border = Border(
    left=Side(style="thin", color="E2E8F0"),
    right=Side(style="thin", color="E2E8F0"),
    top=Side(style="thin", color="E2E8F0"),
    bottom=Side(style="thin", color="E2E8F0"),
)


def style_header_row(ws, row, cols, fill=None):
    f = fill or hdr_fill
    for c in range(1, cols + 1):
        cell = ws.cell(row=row, column=c)
        cell.font = hdr_font
        cell.fill = f
        cell.alignment = center
        cell.border = thin_border


def style_data_row(ws, row, cols, alt=False, highlight=False):
    for c in range(1, cols + 1):
        cell = ws.cell(row=row, column=c)
        cell.font = normal
        cell.alignment = wrap
        cell.border = thin_border
        if highlight:
            cell.fill = highlight_fill
        elif alt:
            cell.fill = light_bg_fill


def set_col_widths(ws, widths):
    for i, w in enumerate(widths, 1):
        ws.column_dimensions[get_column_letter(i)].width = w


# ═══════════════════════════════════════════════════════════════════
# SHEET 1: Executive Summary
# ═══════════════════════════════════════════════════════════════════
ws1 = wb.active
ws1.title = "Executive Summary"
set_col_widths(ws1, [35, 25, 25, 18])

# Title
ws1.merge_cells("A1:D1")
c = ws1["A1"]
c.value = "TCS Agentic AI — End-to-End Incident Response & Application Performance Troubleshooting"
c.font = Font(name="Inter", bold=True, color=WHITE, size=16)
c.fill = PatternFill("solid", fgColor=PRIMARY)
c.alignment = Alignment(horizontal="center", vertical="center")
ws1.row_dimensions[1].height = 48

ws1.merge_cells("A2:D2")
c = ws1["A2"]
c.value = "Fully autonomous incident detection, root cause analysis, and remediation — from pod crash detection through fix verification — orchestrated by AI with ServiceNow ITSM integration, real-time observability, and complete audit trail."
c.font = Font(name="Inter", size=11, color="64748B", italic=True)
c.fill = light_blue_fill
c.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
ws1.row_dimensions[2].height = 48

# Key Impact Numbers
r = 4
ws1.merge_cells(f"A{r}:D{r}")
ws1.cell(r, 1, "KEY IMPACT METRICS").font = bold
ws1.cell(r, 1).fill = accent_fill
ws1.cell(r, 1).font = bold_white
ws1.cell(r, 1).alignment = center
for c in range(2, 5):
    ws1.cell(r, c).fill = accent_fill

r = 5
metrics = [
    ("Mean Time to Detect (MTTD)", "< 30 seconds"),
    ("Mean Time to Resolve (MTTR)", "< 5 minutes"),
    ("Reduction in Manual Effort", "85-90%"),
    ("Audit & Compliance Trail", "100%"),
]
style_header_row(ws1, r, 4, fill=PatternFill("solid", fgColor="0F3460"))
for i, (label, _) in enumerate(metrics, 1):
    ws1.cell(r, i, label)

r = 6
for i, (_, val) in enumerate(metrics, 1):
    cell = ws1.cell(r, i, val)
    cell.font = Font(name="Inter", bold=True, color=GREEN, size=14)
    cell.alignment = center
    cell.fill = light_green_fill
    cell.border = thin_border
ws1.row_dimensions[6].height = 36

# The Challenge
r = 8
ws1.merge_cells(f"A{r}:D{r}")
ws1.cell(r, 1, "THE CHALLENGE: MANUAL INCIDENT RESPONSE").font = bold_white
ws1.cell(r, 1).fill = PatternFill("solid", fgColor=RED)
ws1.cell(r, 1).alignment = center
for c in range(2, 5):
    ws1.cell(r, c).fill = PatternFill("solid", fgColor=RED)

challenges = [
    ("Slow Detection", "SREs rely on alerts that may fire minutes after a pod crash — OOMKilled, CrashLoopBackOff, and ImagePullBackOff often go unnoticed until users report impact"),
    ("Manual Root Cause Analysis", "SREs manually SSH into nodes, run kubectl describe/logs across multiple pods and namespaces, correlate events — often taking 30-60 minutes per incident"),
    ("Knowledge Silos", "Troubleshooting expertise lives in senior SREs' heads; junior team members struggle with unfamiliar error patterns, extending resolution time"),
    ("ServiceNow Gaps", "Incident tickets created manually, often incomplete, missing root cause details, no correlation between detection and resolution evidence"),
    ("No Recovery Validation", "After applying a fix, SREs manually check pod status, restart counts, and resource metrics — no automated verification that the fix actually worked"),
]
r = 9
ws1.cell(r, 1, "Pain Point").font = bold
ws1.cell(r, 2, "Description").font = bold
ws1.merge_cells(f"B{r}:D{r}")
for c in range(1, 5):
    ws1.cell(r, c).fill = light_red_fill
    ws1.cell(r, c).border = thin_border

for i, (pain, desc) in enumerate(challenges):
    row = 10 + i
    ws1.cell(row, 1, pain).font = Font(name="Inter", bold=True, color=RED, size=11)
    ws1.cell(row, 1).border = thin_border
    ws1.merge_cells(f"B{row}:D{row}")
    ws1.cell(row, 2, desc).font = normal
    ws1.cell(row, 2).alignment = wrap
    ws1.cell(row, 2).border = thin_border

# The Solution
r = 16
ws1.merge_cells(f"A{r}:D{r}")
ws1.cell(r, 1, "THE SOLUTION: TCS AGENTIC AI INCIDENT RESPONSE ORCHESTRATOR").font = bold_white
ws1.cell(r, 1).fill = PatternFill("solid", fgColor=GREEN)
ws1.cell(r, 1).alignment = center
for c in range(2, 5):
    ws1.cell(r, c).fill = PatternFill("solid", fgColor=GREEN)

capabilities = [
    ("Natural Language Detection", "Ask 'why is my pod crashing?' in plain English — NLU routes to the pod doctor with automatic pod/namespace extraction"),
    ("8 Parallel K8s API Calls", "Simultaneously fetches pod describe, logs, events, resource metrics, node conditions, deployment config, HPA status, and network policies"),
    ("12 Error Pattern Engine", "Detects OOMKilled, CrashLoopBackOff, ImagePullBackOff, CreateContainerConfigError, Evicted, Pending, ReadinessProbe failures, and 5 more patterns"),
    ("AI Severity Assessment", "Automatically classifies incidents as CRITICAL / WARNING / INFO based on restart count, error frequency, and blast radius"),
    ("ServiceNow Auto-Ticketing", "Creates INC ticket with severity mapping (CRITICAL→SEV-2, WARNING→SEV-3), root cause, evidence, and fix proposals — zero manual input"),
    ("Fix Proposals with Dry Run", "Generates targeted remediation commands with risk scoring, dry-run validation before execution, and one-click apply"),
    ("Recovery Validation", "Post-fix automated verification: pod restarts reset, memory usage normalized, all replicas healthy, incident timeline closed"),
    ("Incident Timeline & Audit", "Complete event timeline from detection through resolution with timestamps, ServiceNow correlation, and before/after metrics"),
]

r = 17
ws1.cell(r, 1, "Capability").font = bold
ws1.cell(r, 2, "Description").font = bold
ws1.merge_cells(f"B{r}:D{r}")
for c in range(1, 5):
    ws1.cell(r, c).fill = light_green_fill
    ws1.cell(r, c).border = thin_border

for i, (cap, desc) in enumerate(capabilities):
    row = 18 + i
    ws1.cell(row, 1, cap).font = Font(name="Inter", bold=True, color=GREEN, size=11)
    ws1.cell(row, 1).border = thin_border
    ws1.cell(row, 1).alignment = wrap
    ws1.merge_cells(f"B{row}:D{row}")
    ws1.cell(row, 2, desc).font = normal
    ws1.cell(row, 2).alignment = wrap
    ws1.cell(row, 2).border = thin_border

# Lifecycle
r = 27
ws1.merge_cells(f"A{r}:D{r}")
ws1.cell(r, 1, "10-PHASE INCIDENT RESPONSE LIFECYCLE").font = bold_white
ws1.cell(r, 1).fill = accent_fill
ws1.cell(r, 1).alignment = center
for c in range(2, 5):
    ws1.cell(r, c).fill = accent_fill

phases = [
    ("01", "Natural Language Query", "~1 sec", "User asks 'why is my pod crashing?' — NLU extracts pod name, namespace, and intent"),
    ("02", "8 Parallel K8s API Calls", "~3 sec", "Fetch pod describe, logs, events, metrics, node info, deployment, HPA, network policies simultaneously"),
    ("03", "12 Error Pattern Detection", "~2 sec", "Match against OOMKilled, CrashLoopBackOff, ImagePullBackOff, Evicted, Pending, and 7 more patterns"),
    ("04", "AI Root Cause Analysis", "~5 sec", "LLM analyzes all evidence, identifies root cause, determines blast radius and affected services"),
    ("05", "Severity Assessment", "~1 sec", "Classify as CRITICAL/WARNING/INFO based on restart count, error frequency, and impact scope"),
    ("06", "ServiceNow INC Creation", "~3 sec", "Auto-create incident ticket with severity, root cause, evidence, fix proposals, and timeline"),
    ("07", "Fix Proposal Generation", "~2 sec", "Generate targeted remediation commands with risk scores, rollback instructions, and dry-run option"),
    ("08", "Dry Run Validation", "~5 sec", "Execute fix in dry-run mode, verify no side effects, confirm resource changes are safe"),
    ("09", "Apply Fix & Monitor", "~30 sec", "Execute remediation, capture before/after metrics, monitor pod recovery in real-time"),
    ("10", "Recovery Verification", "~30 sec", "Verify pod healthy, restarts reset, memory normalized, replicas ready, update INC with resolution"),
]

r = 28
headers = ["Phase", "Step", "Duration", "Description"]
style_header_row(ws1, r, 4)
for i, h in enumerate(headers, 1):
    ws1.cell(r, i, h)

for i, (num, step, dur, desc) in enumerate(phases):
    row = 29 + i
    ws1.cell(row, 1, num).font = bold
    ws1.cell(row, 1).alignment = center
    ws1.cell(row, 1).border = thin_border
    ws1.cell(row, 2, step).font = bold
    ws1.cell(row, 2).border = thin_border
    ws1.cell(row, 3, dur).font = bold_green
    ws1.cell(row, 3).alignment = center
    ws1.cell(row, 3).border = thin_border
    ws1.cell(row, 4, desc).font = normal
    ws1.cell(row, 4).alignment = wrap
    ws1.cell(row, 4).border = thin_border
    if i % 2 == 1:
        for c in range(1, 5):
            ws1.cell(row, c).fill = light_bg_fill


# ═══════════════════════════════════════════════════════════════════
# SHEET 2: Manual vs Automated
# ═══════════════════════════════════════════════════════════════════
ws2 = wb.create_sheet("Manual vs Automated")
set_col_widths(ws2, [28, 22, 22, 14, 30])

ws2.merge_cells("A1:E1")
c = ws2["A1"]
c.value = "Side-by-Side Comparison: Manual vs. TCS Agentic AI Automated Incident Response"
c.font = Font(name="Inter", bold=True, color=WHITE, size=14)
c.fill = hdr_fill
c.alignment = Alignment(horizontal="center", vertical="center")
ws2.row_dimensions[1].height = 40

r = 3
headers = ["Incident Phase", "Manual (SRE Time)", "Automated (Human Time)", "Time Saved", "Automation Method"]
style_header_row(ws2, r, 5)
for i, h in enumerate(headers, 1):
    ws2.cell(r, i, h)

comparison = [
    ("Alert Detection & Triage", "5–15 min", "< 30 sec", "95%", "AI — NLU query parsing, automatic pod/namespace extraction"),
    ("Data Collection (describe, logs, events)", "15–30 min", "~3 sec (8 parallel calls)", "98%", "AUTO — Parallel K8s API calls across all data sources"),
    ("Error Pattern Identification", "10–20 min", "~2 sec", "98%", "AI — 12-pattern recognition engine with confidence scoring"),
    ("Root Cause Analysis", "30–60 min", "~5 sec", "97%", "AI — LLM analysis of all evidence with blast radius assessment"),
    ("Severity Classification", "5–10 min", "~1 sec", "97%", "AUTO — Rule-based severity mapping from error patterns"),
    ("ServiceNow Incident Creation", "15–30 min", "~3 sec", "97%", "AUTO — ServiceNow API with severity, root cause, evidence"),
    ("Fix Proposal Development", "20–45 min", "~2 sec", "97%", "AI — Targeted remediation with risk scoring"),
    ("Dry Run Validation", "15–30 min", "~5 sec", "96%", "AUTO — Automated dry-run execution with safety checks"),
    ("Fix Execution", "10–20 min", "~30 sec", "95%", "AUTO — One-click apply with before/after metrics capture"),
    ("Recovery Verification", "15–30 min", "~30 sec", "96%", "AUTO — Pod health, restart count, memory, replica verification"),
    ("Documentation & Closure", "20–40 min", "~5 sec", "98%", "AUTO — INC updated with timeline, metrics, resolution evidence"),
]

for i, (phase, manual, auto, saved, method) in enumerate(comparison):
    row = 4 + i
    ws2.cell(row, 1, phase).font = bold
    ws2.cell(row, 1).border = thin_border
    ws2.cell(row, 1).alignment = wrap
    ws2.cell(row, 2, manual).font = Font(name="Inter", color=RED, size=11)
    ws2.cell(row, 2).alignment = center
    ws2.cell(row, 2).border = thin_border
    ws2.cell(row, 3, auto).font = Font(name="Inter", color=GREEN, size=11)
    ws2.cell(row, 3).alignment = center
    ws2.cell(row, 3).border = thin_border
    ws2.cell(row, 4, saved).font = bold_green
    ws2.cell(row, 4).alignment = center
    ws2.cell(row, 4).border = thin_border
    ws2.cell(row, 5, method).font = normal
    ws2.cell(row, 5).alignment = wrap
    ws2.cell(row, 5).border = thin_border
    if i % 2 == 1:
        for c in range(1, 6):
            ws2.cell(row, c).fill = light_bg_fill

# Total row
row = 15
ws2.cell(row, 1, "TOTAL (per incident)").font = Font(name="Inter", bold=True, color=WHITE, size=12)
ws2.cell(row, 1).fill = PatternFill("solid", fgColor=PRIMARY)
ws2.cell(row, 1).border = thin_border
ws2.cell(row, 2, "2.5–5.5 hours").font = Font(name="Inter", bold=True, color=WHITE, size=12)
ws2.cell(row, 2).fill = PatternFill("solid", fgColor=RED)
ws2.cell(row, 2).alignment = center
ws2.cell(row, 2).border = thin_border
ws2.cell(row, 3, "< 5 minutes").font = Font(name="Inter", bold=True, color=WHITE, size=12)
ws2.cell(row, 3).fill = PatternFill("solid", fgColor=GREEN)
ws2.cell(row, 3).alignment = center
ws2.cell(row, 3).border = thin_border
ws2.cell(row, 4, "~97%").font = Font(name="Inter", bold=True, color=WHITE, size=12)
ws2.cell(row, 4).fill = PatternFill("solid", fgColor=GREEN)
ws2.cell(row, 4).alignment = center
ws2.cell(row, 4).border = thin_border
ws2.cell(row, 5, "End-to-End AI Orchestration").font = Font(name="Inter", bold=True, color=WHITE, size=11)
ws2.cell(row, 5).fill = PatternFill("solid", fgColor=PRIMARY)
ws2.cell(row, 5).alignment = center
ws2.cell(row, 5).border = thin_border
ws2.row_dimensions[row].height = 32

# Multi-Cluster Scale
r = 18
ws2.merge_cells(f"A{r}:E{r}")
ws2.cell(r, 1, "MULTI-CLUSTER INCIDENT IMPACT AT SCALE").font = bold_white
ws2.cell(r, 1).fill = accent_fill
ws2.cell(r, 1).alignment = center
for c in range(2, 6):
    ws2.cell(r, c).fill = accent_fill

r = 19
for i, h in enumerate(["Environment Scale", "Clusters", "Monthly Incidents (Manual)", "With TCS Agentic AI", "SRE Hours Reclaimed/Month"], 1):
    ws2.cell(r, i, h)
style_header_row(ws2, r, 5)

scale_data = [
    ("Small", "5", "50 incidents × 3.5 hrs = 175 hrs", "50 incidents × 5 min = ~4 hrs", "~171 hours/month"),
    ("Medium", "15", "150 incidents × 3.5 hrs = 525 hrs", "150 incidents × 5 min = ~12.5 hrs", "~512 hours/month"),
    ("Enterprise", "50", "500 incidents × 3.5 hrs = 1,750 hrs", "500 incidents × 5 min = ~42 hrs", "~1,708 hours/month"),
]

for i, (scale, clusters, manual, auto, saved) in enumerate(scale_data):
    row = 20 + i
    ws2.cell(row, 1, scale).font = bold
    ws2.cell(row, 1).border = thin_border
    ws2.cell(row, 2, clusters).font = bold
    ws2.cell(row, 2).alignment = center
    ws2.cell(row, 2).border = thin_border
    ws2.cell(row, 3, manual).font = bold_red
    ws2.cell(row, 3).alignment = center
    ws2.cell(row, 3).border = thin_border
    ws2.cell(row, 4, auto).font = bold_green
    ws2.cell(row, 4).alignment = center
    ws2.cell(row, 4).border = thin_border
    ws2.cell(row, 5, saved).font = bold_green
    ws2.cell(row, 5).alignment = center
    ws2.cell(row, 5).border = thin_border
    if i % 2 == 1:
        for c in range(1, 6):
            ws2.cell(row, c).fill = light_bg_fill


# ═══════════════════════════════════════════════════════════════════
# SHEET 3: Detection & Analysis
# ═══════════════════════════════════════════════════════════════════
ws3 = wb.create_sheet("Detection & Analysis")
set_col_widths(ws3, [22, 40, 16, 30])

ws3.merge_cells("A1:D1")
c = ws3["A1"]
c.value = "AI Detection & Analysis: 12 Error Patterns + 8 Data Sources"
c.font = Font(name="Inter", bold=True, color=WHITE, size=14)
c.fill = hdr_fill
c.alignment = Alignment(horizontal="center", vertical="center")
ws3.row_dimensions[1].height = 40

# Error Patterns Section
r = 3
ws3.merge_cells(f"A{r}:D{r}")
ws3.cell(r, 1, "12 ERROR PATTERN DETECTION ENGINE").font = bold_white
ws3.cell(r, 1).fill = accent_fill
ws3.cell(r, 1).alignment = center
for c in range(2, 5):
    ws3.cell(r, c).fill = accent_fill

r = 4
headers = ["Error Pattern", "Detection Method", "Severity", "Auto-Remediation"]
style_header_row(ws3, r, 4)
for i, h in enumerate(headers, 1):
    ws3.cell(r, i, h)

patterns = [
    ("OOMKilled", "Container last termination reason = OOMKilled; memory usage vs limits analysis", "CRITICAL", "Increase memory limits (patch deployment), identify memory leak source"),
    ("CrashLoopBackOff", "Restart count > 3 with BackOff state; progressive restart interval detection", "CRITICAL", "Analyze exit codes, check config dependencies, rollback to last stable image"),
    ("ImagePullBackOff", "Container waiting reason = ImagePullBackOff; image name and registry analysis", "WARNING", "Verify image tag exists, check registry credentials, suggest correct image"),
    ("CreateContainerConfigError", "Container waiting reason = CreateContainerConfigError; missing ConfigMap/Secret detection", "WARNING", "Identify missing ConfigMap/Secret, check mount paths, verify RBAC permissions"),
    ("Evicted", "Pod phase = Failed, reason = Evicted; node resource pressure analysis", "CRITICAL", "Identify pressure source (disk/memory/PID), rebalance workloads, clean ephemeral storage"),
    ("Pending (Unschedulable)", "Pod phase = Pending; insufficient CPU/memory or node affinity failures", "WARNING", "Analyze resource requests vs available capacity, suggest node scaling or request reduction"),
    ("ReadinessProbe Failure", "Container not ready; readiness probe failing with timeout or HTTP error", "WARNING", "Check probe endpoint health, adjust timeout/threshold, verify service dependencies"),
    ("LivenessProbe Failure", "Container restarting due to liveness probe failure; health endpoint analysis", "CRITICAL", "Analyze probe configuration, check application startup time, adjust initialDelaySeconds"),
    ("Init Container Failure", "Init container in CrashLoopBackOff or Error; dependency chain analysis", "WARNING", "Check init container logs, verify service dependencies, validate init scripts"),
    ("Volume Mount Error", "Container waiting on volume; PVC pending or mount failure", "WARNING", "Check PVC status, StorageClass provisioner, node zone affinity for volumes"),
    ("Node NotReady Impact", "Pod on NotReady node; node condition analysis and cordon status", "CRITICAL", "Identify affected pods, suggest pod migration, analyze node conditions"),
    ("Resource Quota Exceeded", "Pod rejected by admission; namespace quota analysis", "WARNING", "Show current quota usage, suggest quota increase or resource request reduction"),
]

for i, (pattern, method, sev, remediation) in enumerate(patterns):
    row = 5 + i
    ws3.cell(row, 1, pattern).font = bold
    ws3.cell(row, 1).border = thin_border
    ws3.cell(row, 1).alignment = wrap
    ws3.cell(row, 2, method).font = normal
    ws3.cell(row, 2).alignment = wrap
    ws3.cell(row, 2).border = thin_border
    cell_sev = ws3.cell(row, 3, sev)
    cell_sev.alignment = center
    cell_sev.border = thin_border
    if sev == "CRITICAL":
        cell_sev.font = Font(name="Inter", bold=True, color=RED, size=10)
        cell_sev.fill = light_red_fill
    else:
        cell_sev.font = Font(name="Inter", bold=True, color=ORANGE, size=10)
        cell_sev.fill = PatternFill("solid", fgColor="FEF3C7")
    ws3.cell(row, 4, remediation).font = normal
    ws3.cell(row, 4).alignment = wrap
    ws3.cell(row, 4).border = thin_border
    if i % 2 == 1:
        ws3.cell(row, 1).fill = light_bg_fill
        ws3.cell(row, 2).fill = light_bg_fill
        ws3.cell(row, 4).fill = light_bg_fill

# 8 Parallel Data Sources
r = 18
ws3.merge_cells(f"A{r}:D{r}")
ws3.cell(r, 1, "8 PARALLEL K8s API DATA SOURCES").font = bold_white
ws3.cell(r, 1).fill = accent_fill
ws3.cell(r, 1).alignment = center
for c in range(2, 5):
    ws3.cell(r, c).fill = accent_fill

r = 19
headers = ["Data Source", "K8s API Call", "Mode", "Analysis Purpose"]
style_header_row(ws3, r, 4)
for i, h in enumerate(headers, 1):
    ws3.cell(r, i, h)

sources = [
    ("Pod Describe", "GET /api/v1/namespaces/{ns}/pods/{pod}", "Parallel", "Container states, restart counts, exit codes, resource limits, conditions"),
    ("Container Logs", "GET /api/v1/namespaces/{ns}/pods/{pod}/log", "Parallel", "Application errors, stack traces, OOM events, connection failures"),
    ("Pod Events", "GET /api/v1/namespaces/{ns}/events?fieldSelector=involvedObject.name={pod}", "Parallel", "Scheduling decisions, image pulls, probe failures, mount errors"),
    ("Resource Metrics", "GET /apis/metrics.k8s.io/v1beta1/namespaces/{ns}/pods/{pod}", "Parallel", "Current CPU/memory usage vs requests/limits, trend analysis"),
    ("Node Conditions", "GET /api/v1/nodes/{nodeName}", "Parallel", "Node health, resource pressure, kernel version, kubelet status"),
    ("Deployment Config", "GET /apis/apps/v1/namespaces/{ns}/deployments/{deploy}", "Parallel", "Replica count, strategy, image version, environment variables"),
    ("HPA Status", "GET /apis/autoscaling/v2/namespaces/{ns}/hpa", "Parallel", "Current vs desired replicas, scaling metrics, scaling events"),
    ("Network Policies", "GET /apis/networking.k8s.io/v1/namespaces/{ns}/networkpolicies", "Parallel", "Ingress/egress rules, service connectivity, DNS policies"),
]

for i, (source, api, mode, purpose) in enumerate(sources):
    row = 20 + i
    ws3.cell(row, 1, source).font = bold
    ws3.cell(row, 1).border = thin_border
    ws3.cell(row, 1).alignment = wrap
    ws3.cell(row, 2, api).font = Font(name="SF Mono", size=9)
    ws3.cell(row, 2).alignment = wrap
    ws3.cell(row, 2).border = thin_border
    cell_mode = ws3.cell(row, 3, mode)
    cell_mode.alignment = center
    cell_mode.border = thin_border
    cell_mode.font = Font(name="Inter", bold=True, color=GREEN, size=10)
    cell_mode.fill = light_green_fill
    ws3.cell(row, 4, purpose).font = normal
    ws3.cell(row, 4).alignment = wrap
    ws3.cell(row, 4).border = thin_border
    if i % 2 == 1:
        ws3.cell(row, 1).fill = light_bg_fill
        ws3.cell(row, 2).fill = light_bg_fill
        ws3.cell(row, 4).fill = light_bg_fill


# ═══════════════════════════════════════════════════════════════════
# SHEET 4: Real-World Scenarios
# ═══════════════════════════════════════════════════════════════════
ws4 = wb.create_sheet("Incident Scenarios")
set_col_widths(ws4, [28, 24, 20, 24, 34])

ws4.merge_cells("A1:E1")
c = ws4["A1"]
c.value = "Real-World Incident Response Scenarios"
c.font = Font(name="Inter", bold=True, color=WHITE, size=14)
c.fill = hdr_fill
c.alignment = Alignment(horizontal="center", vertical="center")
ws4.row_dimensions[1].height = 40

r = 3
headers = ["Scenario", "Root Cause", "Manual Resolution", "With TCS Agentic AI", "Outcome"]
style_header_row(ws4, r, 5)
for i, h in enumerate(headers, 1):
    ws4.cell(r, i, h)

scenarios = [
    (
        "OOMKilled Pod\nMemory limit exceeded",
        "Java app with memory leak\ncontainer limit 256Mi,\nactual usage 280Mi+",
        "~2 hours\nSSH → describe → logs →\nidentify OOM → patch YAML",
        "~3 min\nDetect → RCA → INC created →\npatch limits → verify recovery",
        "ServiceNow INC auto-created (SEV-2), memory limits increased to 512Mi, pod recovered with 0 restarts, before/after metrics captured"
    ),
    (
        "CrashLoopBackOff\nConfig dependency missing",
        "Deployment references\ndeleted ConfigMap;\ncontainer exits code 1",
        "~1.5 hours\nCheck events → logs →\ntrace config → recreate",
        "~4 min\nDetect → missing config found →\nINC created → fix proposed",
        "AI identified missing ConfigMap 'app-config', suggested recreation from git, ServiceNow INC includes full dependency chain"
    ),
    (
        "ImagePullBackOff\nRegistry auth expired",
        "Image pull secret expired;\nregistry returns 401\nfor private image",
        "~1 hour\nCheck events → test pull →\nrenew secret → rollout",
        "~2 min\nDetect → auth failure identified →\nfix proposed → secret renewed",
        "AI detected 401 from registry, identified expired pull secret, INC created with registry details, new secret applied"
    ),
    (
        "Node NotReady\nMultiple pods affected",
        "Worker node kernel panic;\n12 pods displaced across\n4 namespaces",
        "~3 hours\nIdentify node → list pods →\nmigrate workloads → verify",
        "~5 min\nDetect → blast radius mapped →\npod migration triggered →\nall 12 pods recovered",
        "AI mapped all 12 affected pods across 4 namespaces, auto-triggered pod migration, ServiceNow INC includes full impact assessment"
    ),
    (
        "Evicted Pods\nDisk pressure on node",
        "Ephemeral storage exceeded;\nlogs filling /var/log;\n5 pods evicted",
        "~2 hours\nSSH to node → check disk →\nclean logs → reschedule",
        "~4 min\nDetect → disk pressure found →\ncleanup suggested → pods\nrescheduled → verified",
        "AI identified disk pressure source, suggested ephemeral storage limits and log rotation, 5 pods rescheduled successfully"
    ),
    (
        "Fleet-Wide Incident\n3 clusters affected",
        "Shared image registry\ndowntime; ImagePullBackOff\nacross 3 clusters",
        "~6 hours\nPer-cluster investigation →\ncorrelate → workaround →\nverify each cluster",
        "~8 min\nCorrelate across clusters →\nsingle root cause → fleet fix →\nverify all 3 clusters",
        "AI correlated ImagePullBackOff across 3 clusters to single registry, fleet-wide INC created, registry mirror configured as fix"
    ),
]

for i, (scenario, cause, manual, auto, outcome) in enumerate(scenarios):
    row = 4 + i
    ws4.cell(row, 1, scenario).font = bold
    ws4.cell(row, 1).alignment = wrap
    ws4.cell(row, 1).border = thin_border
    ws4.cell(row, 2, cause).font = normal
    ws4.cell(row, 2).alignment = wrap
    ws4.cell(row, 2).border = thin_border
    ws4.cell(row, 3, manual).font = bold_red
    ws4.cell(row, 3).alignment = center
    ws4.cell(row, 3).border = thin_border
    ws4.cell(row, 4, auto).font = bold_green
    ws4.cell(row, 4).alignment = center
    ws4.cell(row, 4).border = thin_border
    ws4.cell(row, 5, outcome).font = normal
    ws4.cell(row, 5).alignment = wrap
    ws4.cell(row, 5).border = thin_border
    ws4.row_dimensions[row].height = 64
    if i % 2 == 1:
        for c in range(1, 6):
            ws4.cell(row, c).fill = light_bg_fill


# ═══════════════════════════════════════════════════════════════════
# SHEET 5: Safety & Risk Mitigation
# ═══════════════════════════════════════════════════════════════════
ws5 = wb.create_sheet("Safety & Risk Mitigation")
set_col_widths(ws5, [24, 32, 40])

ws5.merge_cells("A1:C1")
c = ws5["A1"]
c.value = "Built-in Safety & Risk Mitigation for Incident Response"
c.font = Font(name="Inter", bold=True, color=WHITE, size=14)
c.fill = hdr_fill
c.alignment = Alignment(horizontal="center", vertical="center")
ws5.row_dimensions[1].height = 40

r = 3
headers = ["Risk Scenario", "Description", "Built-in Mitigation"]
style_header_row(ws5, r, 3)
for i, h in enumerate(headers, 1):
    ws5.cell(r, i, h)

risks = [
    ("Incorrect Root Cause", "AI misidentifies the root cause due to misleading log patterns", "12-pattern engine cross-validates with events, metrics, and node conditions; confidence scoring prevents low-confidence actions"),
    ("Fix Side Effects", "Remediation command causes unintended impact on other workloads", "Dry-run validation before execution; blast radius analysis checks all pods in namespace; rollback instructions included with every fix"),
    ("Over-Scaling Resources", "Memory/CPU limits increased beyond node capacity", "Resource change proposals check node allocatable capacity; HPA analysis prevents conflicting scaling; quota validation ensures namespace limits respected"),
    ("ServiceNow Duplicate", "Multiple INC tickets created for same root cause", "Incident deduplication based on pod name + error pattern + namespace; existing INC checked before creation"),
    ("Cascading Failures", "Fix applied to wrong pod or namespace affects healthy workloads", "Pod and namespace validation before any fix; deployment owner verification; confirmation required for cross-namespace operations"),
    ("Data Loss", "Fix command (like pod delete) causes data loss for stateful workloads", "StatefulSet detection prevents force-delete; PVC analysis checks for unmounted volumes; fix proposals flag data-loss risks explicitly"),
    ("Unauthorized Remediation", "Fix applied without proper change management approval", "All fixes require explicit user confirmation (click 'Apply Fix'); ServiceNow INC creates audit trail; rate limiting prevents automated mass changes"),
    ("Recovery Timeout", "Pod fails to recover after fix, left in broken state", "30-second recovery monitoring with timeout detection; automatic status update to ServiceNow if recovery fails; escalation path to manual intervention"),
]

for i, (risk, desc, mitigation) in enumerate(risks):
    row = 4 + i
    ws5.cell(row, 1, risk).font = Font(name="Inter", bold=True, color=RED, size=11)
    ws5.cell(row, 1).border = thin_border
    ws5.cell(row, 1).alignment = wrap
    ws5.cell(row, 2, desc).font = normal
    ws5.cell(row, 2).alignment = wrap
    ws5.cell(row, 2).border = thin_border
    ws5.cell(row, 3, mitigation).font = Font(name="Inter", bold=True, color=GREEN, size=11)
    ws5.cell(row, 3).alignment = wrap
    ws5.cell(row, 3).border = thin_border
    if i % 2 == 1:
        for c in range(1, 4):
            ws5.cell(row, c).fill = light_bg_fill


# ═══════════════════════════════════════════════════════════════════
# SHEET 6: Key Benefits
# ═══════════════════════════════════════════════════════════════════
ws6 = wb.create_sheet("Key Benefits")
set_col_widths(ws6, [28, 50])

ws6.merge_cells("A1:B1")
c = ws6["A1"]
c.value = "Key Benefits of TCS Agentic AI Incident Response Automation"
c.font = Font(name="Inter", bold=True, color=WHITE, size=14)
c.fill = hdr_fill
c.alignment = Alignment(horizontal="center", vertical="center")
ws6.row_dimensions[1].height = 40

r = 3
style_header_row(ws6, r, 2)
ws6.cell(r, 1, "Benefit")
ws6.cell(r, 2, "Description")

benefits = [
    ("97% Time Reduction", "From 2.5-5.5 hours of manual SRE effort to under 5 minutes per incident — detection through verified resolution"),
    ("Sub-30-Second Detection", "Natural language queries instantly routed to pod doctor; 8 parallel K8s API calls complete in under 3 seconds"),
    ("12-Pattern Intelligence", "Comprehensive error pattern library covering OOMKilled, CrashLoopBackOff, ImagePullBackOff, Evicted, and 8 more — with auto-remediation for each"),
    ("Complete Audit Trail", "Every incident fully documented — ServiceNow INC with severity, root cause, evidence, timeline, before/after metrics, and resolution verification"),
    ("Before/After Metrics", "Quantified proof of fix effectiveness: memory usage, restart counts, pod status, and replica health compared pre- and post-remediation"),
    ("Safe Remediation", "Dry-run validation before every fix; blast radius analysis; rollback instructions; data-loss detection for StatefulSets; rate limiting"),
    ("ServiceNow Native Integration", "Auto-create INC with severity mapping (CRITICAL→SEV-2, WARNING→SEV-3), root cause, evidence, and fix proposals — zero manual ticketing"),
    ("Multi-Cluster Correlation", "Cross-cluster incident correlation identifies fleet-wide issues (shared registry, DNS, networking) with single root cause across clusters"),
    ("Recovery Verification", "Post-fix monitoring confirms pod healthy, restarts reset, memory normalized, all replicas ready — with automatic INC update on success"),
    ("Knowledge Democratization", "Junior SREs get the same diagnosis quality as senior experts — AI captures and applies troubleshooting expertise consistently"),
]

for i, (benefit, desc) in enumerate(benefits):
    row = 4 + i
    ws6.cell(row, 1, benefit).font = bold_green
    ws6.cell(row, 1).border = thin_border
    ws6.cell(row, 1).alignment = wrap
    ws6.cell(row, 2, desc).font = normal
    ws6.cell(row, 2).alignment = wrap
    ws6.cell(row, 2).border = thin_border
    if i % 2 == 1:
        for c in range(1, 3):
            ws6.cell(row, c).fill = light_bg_fill


# ── Save Excel ──
excel_path = os.path.join(OUT_DIR, "TCS-Agentic-AI-Incident-Response-UseCase.xlsx")
wb.save(excel_path)
print(f"Excel saved: {excel_path}")


# ═══════════════════════════════════════════════════════════════════
# HTML GENERATION
# ═══════════════════════════════════════════════════════════════════

def generate_html():
    # Key metrics
    key_metrics_html = ""
    metrics_data = [
        ("< 30s", "Mean Time to Detect"),
        ("< 5 min", "Mean Time to Resolve"),
        ("85-90%", "Effort Reduction"),
        ("12", "Error Patterns"),
        ("8", "Parallel API Calls"),
        ("100%", "Audit Trail"),
    ]
    for num, desc in metrics_data:
        key_metrics_html += f'''
        <div class="kn-card">
          <div class="kn-num">{num}</div>
          <div class="kn-desc">{desc}</div>
        </div>'''

    # Lifecycle steps
    lifecycle_steps = [
        "1. NL Query\nParsing",
        "2. 8 Parallel\nK8s API Calls",
        "3. 12 Error\nPattern Detection",
        "4. AI Root\nCause Analysis",
        "5. Severity\nAssessment",
        "6. ServiceNow\nINC Creation",
        "7. Fix Proposal\nGeneration",
        "8. Dry Run\nValidation",
        "9. Apply Fix\n& Monitor",
        "10. Recovery\nVerification",
    ]
    lifecycle_html = ""
    for step in lifecycle_steps:
        label = step.replace("\n", "<br>")
        lifecycle_html += f'<div class="lc-step">{label}</div>'

    # Comparison table
    comparison_rows = ""
    comparison_data = [
        ("Alert Detection & Triage", "5-15 min", "< 30 sec", "95%"),
        ("Data Collection", "15-30 min", "~3 sec", "98%"),
        ("Error Pattern ID", "10-20 min", "~2 sec", "98%"),
        ("Root Cause Analysis", "30-60 min", "~5 sec", "97%"),
        ("Severity Classification", "5-10 min", "~1 sec", "97%"),
        ("ServiceNow INC", "15-30 min", "~3 sec", "97%"),
        ("Fix Proposal Dev", "20-45 min", "~2 sec", "97%"),
        ("Dry Run Validation", "15-30 min", "~5 sec", "96%"),
        ("Fix Execution", "10-20 min", "~30 sec", "95%"),
        ("Recovery Verification", "15-30 min", "~30 sec", "96%"),
        ("Documentation & Closure", "20-40 min", "~5 sec", "98%"),
    ]
    for phase, manual, auto, saved in comparison_data:
        comparison_rows += f'''
        <tr>
          <td class="phase-name">{phase}</td>
          <td class="manual">{manual}</td>
          <td class="automated">{auto}</td>
          <td class="saved">{saved}</td>
        </tr>'''

    # Error patterns
    pattern_rows = ""
    patterns_html = [
        ("OOMKilled", "CRITICAL", "Container terminated due to memory limit exceeded", "Increase memory limits"),
        ("CrashLoopBackOff", "CRITICAL", "Repeated container crashes with exponential backoff", "Analyze exit codes, rollback image"),
        ("ImagePullBackOff", "WARNING", "Failed to pull container image from registry", "Verify image tag, check pull secret"),
        ("CreateContainerConfigError", "WARNING", "Missing ConfigMap or Secret reference", "Identify missing config, recreate"),
        ("Evicted", "CRITICAL", "Pod evicted due to node resource pressure", "Rebalance workloads, clean storage"),
        ("Pending (Unschedulable)", "WARNING", "Insufficient resources or affinity failures", "Scale nodes or reduce requests"),
        ("ReadinessProbe Failure", "WARNING", "Pod not ready due to failed health check", "Check endpoint, adjust thresholds"),
        ("LivenessProbe Failure", "CRITICAL", "Container restarting from liveness failure", "Adjust probe config, check startup time"),
        ("Init Container Failure", "WARNING", "Init container crash blocking pod start", "Check dependencies, fix init script"),
        ("Volume Mount Error", "WARNING", "PVC pending or mount failure", "Check PVC, StorageClass, zones"),
        ("Node NotReady Impact", "CRITICAL", "Pods affected by unhealthy node", "Migrate pods, analyze node conditions"),
        ("Resource Quota Exceeded", "WARNING", "Pod rejected by admission controller", "Increase quota or reduce requests"),
    ]
    for name, sev, desc, fix in patterns_html:
        sev_class = "sev-crit" if sev == "CRITICAL" else "sev-warn"
        pattern_rows += f'''
        <tr>
          <td class="pattern-name">{name}</td>
          <td class="{sev_class}">{sev}</td>
          <td>{desc}</td>
          <td class="fix-col">{fix}</td>
        </tr>'''

    # Scenarios
    scenario_rows = ""
    scenarios_html = [
        ("OOMKilled Pod", "Java app memory leak, 256Mi limit", "~2 hours", "~3 min", "INC auto-created, limits patched, recovery verified"),
        ("CrashLoopBackOff", "Deleted ConfigMap dependency", "~1.5 hours", "~4 min", "Missing config identified, INC includes dependency chain"),
        ("ImagePullBackOff", "Expired registry pull secret", "~1 hour", "~2 min", "Auth failure detected, secret renewed, INC created"),
        ("Node NotReady", "Kernel panic, 12 pods affected", "~3 hours", "~5 min", "Blast radius mapped, pods migrated, full impact in INC"),
        ("Evicted Pods", "Disk pressure, 5 pods evicted", "~2 hours", "~4 min", "Disk pressure identified, storage limits set, pods rescheduled"),
        ("Fleet-Wide Incident", "Registry down, 3 clusters", "~6 hours", "~8 min", "Cross-cluster correlation, fleet INC, mirror configured"),
    ]
    for name, cause, manual, auto, outcome in scenarios_html:
        scenario_rows += f'''
        <tr>
          <td class="scenario-name">{name}</td>
          <td>{cause}</td>
          <td class="manual">{manual}</td>
          <td class="automated">{auto}</td>
          <td class="outcome">{outcome}</td>
        </tr>'''

    html = f'''<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>TCS Agentic AI — Incident Response Use Case</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');
  * {{ margin: 0; padding: 0; box-sizing: border-box; }}
  body {{ font-family: 'Inter', -apple-system, sans-serif; background: #f0f4f8; color: #1e293b; }}

  .page {{ max-width: 1400px; margin: 0 auto; padding: 24px; }}

  .header {{ background: linear-gradient(135deg, #1A1A2E 0%, #16213E 40%, #0F3460 70%, #E94560 100%);
    color: #fff; padding: 32px 40px; border-radius: 16px; margin-bottom: 24px;
    display: flex; justify-content: space-between; align-items: center; }}
  .header h1 {{ font-size: 22px; font-weight: 800; letter-spacing: -0.5px; }}
  .header p {{ font-size: 13px; color: rgba(255,255,255,0.7); margin-top: 4px; }}
  .header-badge {{ background: rgba(255,255,255,0.15); border: 1px solid rgba(255,255,255,0.25);
    padding: 8px 20px; border-radius: 10px; text-align: center; }}
  .header-badge .big {{ font-size: 22px; font-weight: 800; }}
  .header-badge .small {{ font-size: 11px; color: rgba(255,255,255,0.7); }}

  .kn-grid {{ display: grid; grid-template-columns: repeat(6, 1fr); gap: 12px; margin-bottom: 24px; }}
  .kn-card {{ background: #fff; border-radius: 12px; padding: 16px 12px; text-align: center;
    border: 1px solid #e2e8f0; box-shadow: 0 1px 3px rgba(0,0,0,0.06); }}
  .kn-num {{ font-size: 24px; font-weight: 800; color: #0F3460; }}
  .kn-desc {{ font-size: 10px; color: #64748b; margin-top: 4px; font-weight: 500; }}

  .section {{ margin-bottom: 24px; }}
  .section-title {{ font-size: 18px; font-weight: 700; color: #1A1A2E; margin-bottom: 12px;
    padding-bottom: 8px; border-bottom: 2px solid #E94560; display: inline-block; }}

  .lifecycle {{ display: flex; gap: 0; margin: 16px 0; flex-wrap: wrap; }}
  .lc-step {{ flex: 1; min-width: 90px; padding: 10px 6px; text-align: center;
    color: #fff; font-size: 9px; font-weight: 600; line-height: 1.4;
    position: relative; clip-path: polygon(0 0, calc(100% - 10px) 0, 100% 50%, calc(100% - 10px) 100%, 0 100%, 10px 50%); }}
  .lc-step:first-child {{ clip-path: polygon(0 0, calc(100% - 10px) 0, 100% 50%, calc(100% - 10px) 100%, 0 100%); }}
  .lc-step:nth-child(odd) {{ background: #E94560; }}
  .lc-step:nth-child(even) {{ background: #0F3460; }}

  table {{ width: 100%; border-collapse: collapse; background: #fff;
    border-radius: 12px; overflow: hidden; box-shadow: 0 1px 4px rgba(0,0,0,0.08); margin-bottom: 8px; }}
  thead th {{ background: #1A1A2E; color: #fff; padding: 12px 14px;
    font-size: 12px; font-weight: 700; text-align: center; text-transform: uppercase;
    letter-spacing: 0.5px; border-right: 1px solid rgba(255,255,255,0.15); }}
  thead th:last-child {{ border-right: none; }}
  tbody td {{ padding: 10px 14px; border-bottom: 1px solid #e5e7eb;
    vertical-align: top; font-size: 12px; line-height: 1.5; }}
  tbody tr:nth-child(even) {{ background: #f8fafc; }}
  tbody tr:hover {{ background: #eff6ff; }}

  .phase-name, .pattern-name, .scenario-name {{ font-weight: 700; color: #1A1A2E; }}
  .manual {{ color: #DC2626; font-weight: 700; text-align: center; vertical-align: middle !important; }}
  .automated {{ color: #16A34A; font-weight: 700; text-align: center; vertical-align: middle !important; }}
  .saved {{ color: #16A34A; font-weight: 800; font-size: 14px; text-align: center; vertical-align: middle !important; }}
  .outcome {{ font-style: italic; color: #0F3460; font-size: 11px; }}
  .fix-col {{ color: #16A34A; font-weight: 600; }}

  .sev-crit {{ color: #DC2626; font-weight: 800; text-align: center; vertical-align: middle !important;
    background: #FEE2E2 !important; }}
  .sev-warn {{ color: #E67E22; font-weight: 700; text-align: center; vertical-align: middle !important;
    background: #FEF3C7 !important; }}

  .total-row {{ background: #1A1A2E !important; }}
  .total-row td {{ color: #fff; font-weight: 700; font-size: 13px; text-align: center; }}

  .summary-grid {{ display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 24px; }}
  .summary-card {{ background: #fff; border-radius: 12px; padding: 20px;
    border: 1px solid #e2e8f0; box-shadow: 0 1px 3px rgba(0,0,0,0.06); }}
  .summary-card h3 {{ font-size: 14px; font-weight: 700; color: #1A1A2E; margin-bottom: 12px;
    padding-bottom: 6px; border-bottom: 2px solid #E94560; }}
  .summary-card.challenge {{ border-left: 4px solid #DC2626; }}
  .summary-card.solution {{ border-left: 4px solid #16A34A; }}
  .summary-card ul {{ list-style: none; padding: 0; }}
  .summary-card li {{ padding: 4px 0; font-size: 12px; }}
  .summary-card.challenge li::before {{ content: "\\2718 "; color: #DC2626; font-weight: 700; }}
  .summary-card.solution li::before {{ content: "\\2714 "; color: #16A34A; font-weight: 700; }}

  .footer {{ text-align: center; margin-top: 24px; padding: 16px;
    color: #94a3b8; font-size: 11px; }}

  @media print {{
    body {{ background: #fff; }}
    .page {{ padding: 0; max-width: 100%; }}
    .header {{ border-radius: 0; }}
    table {{ box-shadow: none; border: 1px solid #ccc; }}
  }}
</style>
</head>
<body>
<div class="page">

  <div class="header">
    <div>
      <h1>TCS Agentic AI — Use Case 2</h1>
      <p>End-to-End Incident Response &amp; Application Performance Troubleshooting</p>
    </div>
    <div style="display:flex;gap:12px;">
      <div class="header-badge">
        <div class="big">12</div>
        <div class="small">Error Patterns</div>
      </div>
      <div class="header-badge">
        <div class="big">8</div>
        <div class="small">Parallel API Calls</div>
      </div>
      <div class="header-badge">
        <div class="big">< 5 min</div>
        <div class="small">Mean Time to Resolve</div>
      </div>
    </div>
  </div>

  <div class="kn-grid">{key_metrics_html}</div>

  <div class="summary-grid">
    <div class="summary-card challenge">
      <h3>The Challenge: Manual Incident Response</h3>
      <ul>
        <li>SREs spend 30-60 min manually collecting logs, events, and metrics per incident</li>
        <li>Root cause analysis requires senior expertise — knowledge silos slow junior SREs</li>
        <li>ServiceNow tickets created manually, often incomplete, no evidence correlation</li>
        <li>No automated recovery validation — SREs manually check if fixes actually worked</li>
        <li>Average 2.5-5.5 hours per incident from detection to verified resolution</li>
      </ul>
    </div>
    <div class="summary-card solution">
      <h3>The Solution: TCS Agentic AI</h3>
      <ul>
        <li>Natural language queries — ask "why is my pod crashing?" and get instant diagnosis</li>
        <li>8 parallel K8s API calls collect all evidence in under 3 seconds</li>
        <li>12 error patterns with auto-remediation proposals and risk scoring</li>
        <li>ServiceNow INC auto-created with severity, root cause, evidence, and timeline</li>
        <li>Before/after metrics capture proves fix effectiveness with quantified evidence</li>
      </ul>
    </div>
  </div>

  <div class="section">
    <div class="section-title">10-Phase Incident Response Lifecycle</div>
    <div class="lifecycle">{lifecycle_html}</div>
    <p style="font-size:12px;color:#64748b;margin-top:8px;">
      Each phase produces audit trail entries. ServiceNow INC is auto-created with severity mapping,
      root cause, evidence, fix proposals, and resolution verification. Before/after metrics provide
      quantified proof that the fix worked.
    </p>
  </div>

  <div class="section">
    <div class="section-title">Manual vs. Automated: Side-by-Side Comparison</div>
    <table>
      <thead>
        <tr>
          <th>Incident Phase</th>
          <th>Manual (SRE Time)</th>
          <th>Automated (AI Time)</th>
          <th>Time Saved</th>
        </tr>
      </thead>
      <tbody>
        {comparison_rows}
        <tr class="total-row">
          <td>TOTAL (per incident)</td>
          <td style="color:#FEE2E2;">2.5-5.5 hours</td>
          <td style="color:#DCFCE7;">&lt; 5 minutes</td>
          <td style="color:#DCFCE7;">~97%</td>
        </tr>
      </tbody>
    </table>
  </div>

  <div class="section">
    <div class="section-title">12 Error Pattern Detection Engine</div>
    <table>
      <thead>
        <tr>
          <th>Pattern</th>
          <th>Severity</th>
          <th>Description</th>
          <th>Auto-Remediation</th>
        </tr>
      </thead>
      <tbody>{pattern_rows}</tbody>
    </table>
  </div>

  <div class="section">
    <div class="section-title">Real-World Incident Scenarios</div>
    <table>
      <thead>
        <tr>
          <th>Scenario</th>
          <th>Root Cause</th>
          <th>Manual</th>
          <th>With AI</th>
          <th>Outcome</th>
        </tr>
      </thead>
      <tbody>{scenario_rows}</tbody>
    </table>
  </div>

  <div class="footer">
    Powered by TCS &mdash; Tata Consultancy Services. All rights reserved. &nbsp;|&nbsp; Generated for hackathon demonstration purposes.
  </div>

</div>
</body>
</html>'''

    html_path = os.path.join(OUT_DIR, "TCS-Agentic-AI-Incident-Response-UseCase.html")
    with open(html_path, "w") as f:
        f.write(html)
    print(f"HTML saved: {html_path}")
    return html_path


# ═══════════════════════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    generate_html()
    print(f"\nDone! Files generated:")
    print(f"  Excel: {excel_path}")
