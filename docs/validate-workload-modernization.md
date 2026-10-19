# Validating the Workload Modernization Agent

One VMware VM, built once and changed twice. Each stage proves a different
capability, and **stage 2 is the one that proves the agent is really reading
the machine** rather than reciting a per-runtime convention.

Requires commit `e23d9d0` or later — the build that reads `guest.disk` and
`/proc/net/tcp`. Without it there are no mounts and no ports.

---

## 00 — Before you start

The agent reaches VMs **through MTV**, not vCenter directly. It borrows the
vCenter credential the MTV provider already holds, so vCenter is not configured
twice.

- [ ] **MTV / Forklift operator installed** on the cluster
- [ ] **A vSphere Provider created in MTV** pointing at your vCenter
- [ ] **The build with guest file reads deployed** (`e23d9d0` or later)

### vCenter role — two privileges, doing different jobs

Both live under **Virtual Machine → Guest Operations**.

| Privilege | Without it |
|---|---|
| Guest Operation Program Execution *(query)* | No process list — nothing is detected at all |
| Guest Operation Modifications *or* File Query | Processes work, **ports fail** — and the agent says exactly that |

### Use `root` as the guest credential

`ListProcessesInGuest` runs **as** the account you give it. An unprivileged user
sees only its own processes, and the scorer catches that:

> every visible process is owned by "X" … An unprivileged guest credential sees
> its own processes and little else.

Good that it notices, but it clouds the test. `/proc/net/tcp` is world-readable,
so ports work with any account — the process list is what needs root.

---

## 01 — Build the VM

RHEL 9 or Rocky 9 · 2 vCPU · 4 GB RAM · 50 GB root disk. Nothing else attached
yet; the second disk comes in stage 3.

```bash
dnf install -y open-vm-tools java-17-openjdk-headless wget tar
systemctl enable --now vmtoolsd
systemctl status vmtoolsd --no-pager
```

**open-vm-tools is not optional.** Every read goes through it — guest
properties, the process list, the file transfer. No Tools, no assessment. The
agent reports it as *"VMware Tools is not running in this guest"* rather than as
a failure to read.

### Tomcat and a real application

Check the current 10.1.x at `tomcat.apache.org` first; the patch version moves.

```bash
VER=10.1.34
useradd -r -m -U -d /opt/tomcat -s /bin/false tomcat
cd /tmp && wget https://dlcdn.apache.org/tomcat/tomcat-10/v$VER/bin/apache-tomcat-$VER.tar.gz
tar xzf apache-tomcat-$VER.tar.gz -C /opt/tomcat --strip-components=1
chown -R tomcat:tomcat /opt/tomcat && chmod +x /opt/tomcat/bin/*.sh

# a real war, so stage 4 has something to actually build
wget -O /opt/tomcat/webapps/sample.war \
  https://tomcat.apache.org/tomcat-10.1-doc/appdev/sample/sample.war

cat >/etc/systemd/system/tomcat.service <<'EOF'
[Unit]
After=network.target
[Service]
Type=forking
User=tomcat
Environment=JAVA_HOME=/usr/lib/jvm/jre-17
Environment=CATALINA_HOME=/opt/tomcat
Environment=CATALINA_BASE=/opt/tomcat
ExecStart=/opt/tomcat/bin/startup.sh
ExecStop=/opt/tomcat/bin/shutdown.sh
[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload && systemctl enable --now tomcat
ss -ltnp | grep -E '8080|8009'
```

---

## 02 — Stage 1: it should find Tomcat

`readPorts` is opt-in on this tool and on no other.

```
containerize_inspect_guest
  provider:      <your-mtv-provider>
  vm:            <vm-name>
  readPorts:     true
  guestUsername: root
  guestPassword: ********
```

**Expect:**

- **Apache Tomcat** detected — matched on `catalina` in the command line, not
  on the VM name
- **Mounts**: `/` and `/boot`, **0 carrying data**
- **Listening ports**: `22` (infrastructure), `8009`, `8080`
- The line *"One application port: 8080."*

Then `containerize_plan` with the same arguments: verdict **container with
work**, `EXPOSE 8080`, and the port under **findings** as *"Read, not assumed"* —
not under assumptions.

---

## 03 — Stage 2: the test that actually proves it

Everything so far is equally consistent with the agent simply knowing that
Tomcat conventionally uses 8080. This stage removes that explanation.

```bash
sed -i 's/port="8080"/port="9090"/' /opt/tomcat/conf/server.xml
systemctl restart tomcat
ss -ltnp | grep 9090
```

Re-run `containerize_plan`.

| Result | Means |
|---|---|
| `EXPOSE 9090`, finding reads *"listens on 9090, not the conventional 8080"* | **The read is real.** This is the whole point of the feature |
| Still `EXPOSE 8080` | The file read is not working — see section 06 |

**Why this one matters.** Before this capability the agent would have written
`8080` with confidence. The image builds, the pod starts, a TCP probe on the
wrong port passes or fails for reasons nobody connects to the port, and the
application serves nothing — and it all looks like success until cutover.

---

## 04 — Stage 3: it should refuse

Add a **100 GB disk** to the VM in vCenter, then give it a database.

```bash
lsblk                                   # find the new device, e.g. /dev/sdb
mkfs.xfs /dev/sdb
mkdir -p /var/lib/pgsql && mount /dev/sdb /var/lib/pgsql
echo "/dev/sdb /var/lib/pgsql xfs defaults 0 0" >> /etc/fstab

dnf install -y postgresql-server
chown postgres:postgres /var/lib/pgsql
postgresql-setup --initdb
systemctl enable --now postgresql
```

**Wait about a minute.** `guest.disk` updates on the VMware Tools heartbeat, not
instantly. If the mount is missing on the first run, re-run before concluding
anything.

**Expect:**

- Verdict flips to **Keep as a VM**
- Blocker **"PostgreSQL is running on this machine"**, evidence
  `/usr/pgsql-*/bin/postgres -D /var/lib/pgsql/…`
- Concern **"1 mount outside the operating system carries data"** —
  `/var/lib/pgsql 100.0 GiB`
- `containerize_plan` **refuses** — no Containerfile generated

The mount finding is the part that only exists post-deployment. On the old build
you would get the Postgres blocker but nothing about the 100 GB volume. A mount
under **1 GiB** (`DATA_MOUNT_MIN_BYTES`) is treated as a mount point rather than
a data volume, so make the disk comfortably larger than that.

---

## 05 — Optional: take it to a build

Only meaningful on a machine the agent cleared, so revert stage 3 first (stop
Postgres, unmount) or use a second VM.

```
containerize_build_manifests
  provider:       <your-mtv-provider>
  vm:             <vm-name>
  buildNamespace: openshift-mcp
  guestUsername:  root
  guestPassword:  ********
```

Returns an ImageStream, a BuildConfig carrying the reviewed Containerfile
inline, and a Tekton pipeline — **proposed, not started**. To actually build it
you supply the WAR yourself, because the agent never read the application's
files:

```bash
mkdir -p ~/app01-build/target
cp sample.war ~/app01-build/target/ROOT.war
oc apply -n openshift-mcp -f imagestream-app01.yaml -f buildconfig-app01.yaml
cd ~/app01-build && oc start-build app01 --from-dir=. --follow -n openshift-mcp
```

**Expect the first build to fail.** That sentence ships with the proposal: every
placeholder path in the Containerfile is a guess the agent was explicit about,
and the first failure on a missing `COPY` source is the system working.

---

## 06 — If something does not fire

The agent distinguishes these deliberately. Each has a different fix, and "could
not read" as a single message sends someone to the wrong team.

| What it says | What to do |
|---|---|
| *VMware Tools is not running in this guest* | `systemctl start vmtoolsd` |
| *The guest credential was rejected inside the machine* | It is an account **inside the guest**, not a vCenter login |
| *missing the Guest Operations privilege… Program Execution (query)* | Add the first vCenter privilege from section 00 |
| *missing the Guest Operations privilege… Modifications or File Query* | Add the second one. This is the ports-only failure |
| */proc/net/tcp does not exist in this guest* | You are on Windows. Expected — no `/proc`, and no equivalent that does not run a command |
| *The mount table was not reported* | Tools too old, or the heartbeat has not run. Wait and retry |
| *every visible process is owned by …* | Re-run as `root` |
| *The machine is poweredOff* | Nothing is read from a machine that is not running — a state, not an error |

### One behaviour that is not a bug

`containerize_assess` — the fleet view — does **not** read ports. Two file reads
per machine across a whole estate is not worth it. Ports come from
`containerize_inspect_guest` with `readPorts: true`, and always from
`containerize_plan` and `containerize_build_manifests`. Mounts appear
everywhere, because they cost nothing.

---

## What each stage exercises, in code

| Stage | Module | What breaks if it regresses |
|---|---|---|
| 1 — detection | `containerization-readiness.js` → `detectRuntimes` | Nothing is recognised; every machine reads as "no recognised runtime" |
| 1 — mounts | `guest-discovery.js` → `parseGuestDisks` | `guest.disk` silently absent; attached storage invisible |
| 2 — ports | `guest-files.js` + `guest-ports.js` → `parseProcNetTcp`, `reconcilePort` | The port reverts to a convention without saying so |
| 3 — refusal | `containerization-readiness.js` → `detectDatastores`, `dataMounts` | A database host becomes a container candidate |
| 5 — build | `containerization-plan.js`, `build-pipeline.js` | Manifests stop matching the Containerfile |

The same paths are covered by `src/agents/canaries/containerization.js`, which
runs without a cluster. Run those first if a stage fails — if the canaries pass
and the stage does not, the problem is the environment, not the code.
