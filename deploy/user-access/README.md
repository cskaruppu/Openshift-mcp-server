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
Last-login dates come from OAuth access tokens and are shown only where the
platform may list them.
