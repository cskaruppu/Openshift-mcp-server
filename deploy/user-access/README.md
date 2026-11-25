# User & Access

Automation Hub → **User & Access** shows who can log in to which cluster and
with what rights, across every cluster the hub manages, and changes it through
approved requests.

## How access is given

OpenShift has no "create a user with a password" API: people come from an
identity provider. So a grant is one of:

| Mode | What happens on each chosen cluster | Password |
|---|---|---|
| **Company login (AD / SSO)** — recommended | The person is added to a platform-managed group (`tcs-<role>-<namespace>`), which is bound to the role | None; they log in with their company account |
| **Local user (htpasswd)** — labs and emergency accounts | A bcrypt entry is added to the htpasswd Secret the OAuth config uses, then the same group and binding | Generated at approval, shown once to the approver, never stored |

Roles offered: `view`, `edit`, `admin` (per namespace), `cluster-reader`,
`cluster-admin` (cluster-wide). A grant can have an end date; access is taken
away automatically every 10 minutes after it passes (`USER_ACCESS_EXPIRY_TICK_MS`).

Groups synced from AD/LDAP are never edited here (the next sync would undo it):
the screen says to change them in the directory.

## Approval

Every change is a request. There are two ways to approve it, whichever comes first:

- **In ServiceNow (ITSM).** With "Approve in ServiceNow" ticked (the default),
  submitting raises a ServiceNow change request. The hub checks it every 2
  minutes (`USER_ACCESS_SNOW_POLL_MS`): once it is **approved**, the change is
  applied and recorded as approved by that change; if it is **rejected**, the
  request is rejected. A pending request can also be sent later with "Send to
  ServiceNow". Local (htpasswd) users are the exception: after ServiceNow
  approves, an Admin applies them in the platform, because the one-time
  password is shown to that person.
- **In the platform.** An Admin other than the requester presses Approve. With
  a single administrator, set `USER_ACCESS_ALLOW_SELF_APPROVE=true` (or use the
  ServiceNow route).

Requests, approvals, results per cluster and expiries are in the audit trail.

## How each cluster is reached

- **A cluster with a spoke agent** does the work itself: the hub calls the
  agent's `/api/user-access/local/*` endpoint, and the agent uses its own
  service account. Agents must run this version or later; an older agent is
  reported as such.
- **The Private AI GPU cluster** uses the access set up for Private AI.
- **Other clusters** use stored credentials or the agent's API token, as the
  rest of the hub does. A cluster reached only through the read-only bridge is
  reported as not changeable.

## Delivery

- **Directly** — the hub applies the change on each cluster (through the spoke
  agent's credentials or direct access; a cluster reached only through the
  read-only bridge reports that it cannot be changed).
- **ACM policy** — nothing is applied; you get a `Policy` that enforces the
  group and binding, to apply on the ACM hub with a Placement.
- **GitOps** — nothing is applied; you get the Group and RoleBinding YAML for
  your repository. Local (htpasswd) users can only be applied directly, so a
  password hash never goes into Git or a policy.

## One person: where, what, and lifecycle

Click a name to open their panel:

- **Where they exist** — each cluster, how they log in there (AD, SSO,
  htpasswd), when their user record was created, active sessions, and whether
  a local login is locked.
- **Roles** — every role on every cluster: what it is, where (cluster or
  namespace), how it is given (a group, or directly), the binding, which
  request granted it and who approved it, and when it ends. **Remove** takes
  away just that role (their place in the group, or the direct binding).
- **What these roles allow** — a plain description of each role, the
  description OpenShift attaches to it, and the verbs its rules allow.
- **Can they…?** — a live permission check on a cluster (a
  SubjectAccessReview with their groups), e.g. "can they delete pods in
  payments?".
- **History** — every request about them.

Lifecycle actions, each an approved request:

| Action | What happens on each cluster | Undo |
|---|---|---|
| **Remove a role** | Out of that group, or that binding | Grant again |
| **Disable** | Groups and direct bindings recorded, then removed; local login locked; **active sessions ended** | **Enable** restores exactly what was recorded |
| **Delete everywhere** (leaver) | All of the above, plus the htpasswd entry, User and Identity objects | None |
| **Reset password** (local users) | New bcrypt hash in the htpasswd Secret, old sessions ended; the password is shown once to the approver | — |
| **Temporary access** | A grant that ends 1, 2, 4, 8, 24 or 72 hours after approval | Automatic |

OpenShift has no "disabled user" flag: Disable is this reversible suspension.
For AD/SSO users, also disable the account in the directory (the panel says
when they are still in an AD-synced group).

Password rotation: on a local user, "Rotate password every 30–365 days"; the
Governance tab lists who is due or overdue, with **Reset now**.

## Governance tab

- **Unofficial access** — cluster-admin and admin grants not made through the
  platform (e.g. `oc adm policy` by hand). **Accept** records one as intended;
  **Accept all** sets today as the approved state, so only new ones appear;
  **Request removal** raises a request to take it out.
- **Separation of duties** — no cluster-admin given directly to a person; no
  local (htpasswd) cluster-admin on production; approvers do not also hold
  cluster-admin on production; no standing cluster-admin on every cluster.
  Production is any cluster name matching `USER_ACCESS_PROD_PATTERN`
  (default `prod`).
- **Possible leavers** — logs in through AD but is no longer in any AD-synced
  group (needs LDAP group sync), with **Disable**.
- **Privileged service accounts** — cluster-admin or admin outside the
  platform's own namespaces.
- **Entitlement report** — CSV for auditors: person, login, cluster, role,
  scope, how it is given, binding, request, approver, end date.

## Access reviews tab

An Admin starts a review (privileged roles only, or every role) with a due
date. Reviewers mark each grant **Keep** or **Remove**. Closing turns every
Remove — and, if chosen, every grant nobody confirmed — into removal requests,
which are approved like any other.

## Notifications

Requests, approvals, expiries and reviews go to the notification channels set
up in Settings (Teams, Slack, e-mail) when there are any.

## Remove everywhere, and kubeadmin

"Remove everywhere" takes a person out of every non-synced group, removes
bindings that name them directly, removes their htpasswd entry, and deletes
their User and Identity objects, on each chosen cluster. It refuses to remove
the only cluster-admin who can log in.

"Request removal" on kubeadmin deletes `kube-system/kubeadmin` only where an
identity provider exists and someone else holds cluster-admin.

## Permissions

Apply `rbac.yaml` on each cluster to be managed. It binds the hub, spoke-agent
and Private AI access service accounts, and includes `bind` on the five offered
roles, which Kubernetes requires before an account can grant them. Without it a
cluster shows as "not readable".

## Not covered

Adding or changing identity providers (OAuth config) and LDAP group sync jobs
are not changed from this screen; it shows which clusters lack company login.
Failed-login monitoring needs the OpenShift audit logs forwarded (e.g. to
Loki or a SIEM) and is not part of this screen.
Last-login dates come from OAuth access tokens and are shown only where the
platform may list them.
