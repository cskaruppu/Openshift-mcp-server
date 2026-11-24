# UC-16 — Workload Modernization

**TCS Agentic AI for Hybrid Infrastructure · Application Modernization**

> *For every VM: should it become a container, or stay a VM — and why.*

## 1. Summary

| Field | Value |
|---|---|
| Use case ID | UC-16 |
| Name | Workload Modernization |
| Agent | Workload Modernization Agent (Automation Hub) |
| Trigger | Human-initiated, on a wave of VMware VMs |
| Input | vCenter through the credential MTV already holds; VMware Tools guest operations; optionally Red Hat MTA |
| Output | A disposition per VM (container candidate, keep as VM, blocked, unread), proposed Containerfile and OpenShift manifests |
| Prerequisite | MTV provider for vCenter; VMware Tools running in the guests; a guest credential for process reads |

## 2. The problem

Modernisation programmes promise containers for everything, then stall: the
VM runs a database, holds a node-locked licence, or nobody knows what runs on
it. Tools that only build containers cannot say "keep this one as a VM".

## 3. What it does

1. Reads guest OS, addresses and the running process list through VMware Tools — nothing installed, nothing executed in the guest.
2. Recognises the runtime from command lines (Tomcat, JBoss, WebLogic, WebSphere, Spring Boot, .NET, Node.js, Python, PHP, Ruby, nginx, httpd).
3. Blocks with the reason: a local database, a desktop session, OS clustering, a node-locked licence daemon, nested virtualisation, an existing container host.
4. Reports the candidate rate twice — against the whole estate and against machines that answered — and never scores a machine it could not read.
5. Proposes a hardened Containerfile on UBI and OpenShift manifests (non-root, read-only root filesystem, default-deny NetworkPolicy), listing every assumption.
6. Hands code analysis to Red Hat MTA rather than reproducing it.

## 4. Business value

| Metric | Without | UC-16 |
|---|---|---|
| "What runs on this VM?" | Interviews and spreadsheets | Read from the guest |
| Wrong candidates | Found during the build | Blocked with the reason first |
| Pilot numbers | Inflated by unread machines | Two candidate rates, honest |

## 5. Implementation map

| Part | Where |
|---|---|
| Agent manifest and capabilities | `src/agents/manifests/containerization.json` |
| Console | `console/src/components/ContainerizationAgent.jsx` |

## 6. Verification status

| Claim | Status |
|---|---|
| Scoring, blockers, runtime detection, fleet rates | ✅ Unit-tested (`containerization.test.js`, `fleet-containerization.test.js`) |
| Guest reads against a real vCenter | 🔶 Confirm live status before demonstrating |

## 7. Related

UC-10 (the VMs that stay VMs migrate) · UC-07 (deploying the result).
