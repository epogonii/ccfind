import fs from 'node:fs';
import path from 'node:path';

const HOME = process.argv[2];
const root = path.join(HOME, '.claude', 'projects');
fs.rmSync(root, { recursive: true, force: true });

let uuidN = 0;
const uuid = () => {
  const h = (n) => (uuidN + n).toString(16).padStart(4, '0');
  uuidN += 7;
  return `${h(0)}${h(1)}-${h(2)}-4${h(3).slice(1)}-8${h(4).slice(1)}-${h(5)}${h(6)}${h(7)}`;
};

const SESSIONS = [
  {
    project: '-home-dev-infra', cwd: '/home/dev/infra', branch: 'main',
    title: 'node-reboot', day: '2026-07-28', id: 'a1b2c3d4-5e6f-4a89-8bcd-ef1234567890',
    turns: [
      ['reboots on the workers hang for minutes, find out why',
       'Looking at the kubelet journal on worker-2 first - a hang that long usually means the shutdown manager is waiting on something.',
       ['Bash', { command: 'journalctl -u kubelet -b -1 | grep -i shutdown' },
        'Failed to start node shutdown manager: node shutdown manager was timed out after 5 attempts waiting for logind InhibitDelayMaxSec to update to 2m0s, current value is 30s'],
       'Found it. kubelet asks logind to raise `InhibitDelayMaxSec` to 2m so it can drain pods before the box goes down. The value stays at 30s, kubelet gives up after 5 attempts, and every reboot then waits out the full timeout.'],
      ['so my logind.conf edit does nothing?',
       'Your edit is there but it is being overridden. A drop-in beats the main file, and unattended-upgrades ships one.',
       ['Bash', { command: 'systemd-analyze cat-config systemd/logind.conf | grep -n InhibitDelayMaxSec' },
        '/etc/systemd/logind.conf:25:#InhibitDelayMaxSec=5\n/usr/lib/systemd/logind.conf.d/unattended-upgrades-logind-maxdelay.conf:2:InhibitDelayMaxSec=30\n/etc/systemd/logind.conf.d/10-kubelet-shutdown.conf:2:InhibitDelayMaxSec=120'],
       'Confirmed: the drop-in from unattended-upgrades sets 30s and wins over your commented-out line. Own drop-in with a higher prefix fixes it, then `systemctl restart systemd-logind`.'],
    ],
  },
  {
    project: '-home-dev-infra', cwd: '/home/dev/infra', branch: 'main',
    title: 'registry-mirror', day: '2026-07-30', id: 'b2c3d4e5-6f70-4b9a-9cde-f01234567891',
    turns: [
      ['containerd keeps pulling from docker.io even though the mirror is configured',
       'The mirror config lives in certs.d. Let me check whether containerd is reading that directory at all.',
       ['Bash', { command: 'grep -A2 registry /etc/containerd/config.toml' },
        '[plugins."io.containerd.grpc.v1.cri".registry]\n  config_path = "/etc/containerd/certs.d:/etc/docker/certs.d"'],
       'That is the bug. With two paths joined by a colon the CRI plugin silently ignores `hosts.toml` entirely - it does not split on the colon, it treats the whole string as one directory that does not exist. Single path only.'],
      ['it never logged anything about it',
       'It never does. There is no warning and no error - pulls just go to the upstream registry as if no mirror were configured. Fixed and verified:',
       ['Bash', { command: 'crictl pull registry.internal/nginx:1.27 && crictl images | head -3' },
        'Image is up to date for sha256:9c1b3f2e\nregistry.internal/nginx  1.27  9c1b3f2e  187MB'],
       'Pulling through the mirror now. Left a note in the runbook, since nothing in the logs would ever point at the colon.'],
    ],
  },
  {
    project: '-home-dev-platform', cwd: '/home/dev/platform', branch: 'stage',
    title: 'tls-renewal', day: '2026-08-04', id: 'c3d4e5f6-7081-4cab-a0de-f12345678902',
    turns: [
      ['the wildcard cert expires in 6 days and renewal is failing',
       'Renewal needs the DNS-01 challenge to resolve. Checking what the ACME client sees:',
       ['Bash', { command: 'certbot renew --dry-run 2>&1 | tail -4' },
        'Detail: DNS problem: NXDOMAIN looking up TXT for _acme-challenge.internal.example - check that a DNS record exists for this domain'],
       'The TXT record is not being published: the API token for the DNS provider lost its zone-edit scope in a rotation last week. New token with the right scope, then renew.'],
    ],
  },
  {
    project: '-home-dev-platform', cwd: '/home/dev/platform', branch: 'stage',
    title: 'slow-endpoint', day: '2026-08-11', id: 'd4e5f607-1829-4dbc-b1ef-023456789013',
    turns: [
      ['the orders endpoint got slow after yesterday deploy',
       'Comparing query plans before and after. The p99 tripled, so I would expect an index to have stopped being used.',
       ['Bash', { command: 'psql -c "explain (analyze) select * from orders where tenant_id=$1 and created_at > now() - interval 7 day"' },
        'Seq Scan on orders  (cost=0.00..184203.11 rows=1122 width=284) (actual time=812.4..1904.7 rows=1096 loops=1)\nPlanning Time: 0.213 ms\nExecution Time: 1905.2 ms'],
       'Sequential scan on 4M rows. The migration dropped the composite index on `(tenant_id, created_at)` and recreated only `(tenant_id)`, so the range predicate has nothing to walk.'],
    ],
  },
  {
    project: '-home-dev-ci', cwd: '/home/dev/ci', branch: 'main',
    title: 'flaky-runner', day: '2026-08-14', id: 'e5f60718-2930-4ecd-82f0-134567890124',
    turns: [
      ['CI fails one run in four, always a different test',
       'A different test each time usually means the runner, not the tests. Checking whether it is being evicted:',
       ['Bash', { command: 'kubectl get events --field-selector reason=Evicted -A | head -3' },
        'default  runner-7d9f4  Evicted  The node was low on resource: ephemeral-storage. Container runner was using 21Gi, which exceeds its request of 0.'],
       'The runner has no ephemeral-storage request, so the kubelet evicts it whenever the node fills up. Whichever test is running when that happens is the one that "fails".'],
    ],
  },
  {
    project: '-home-dev-infra', cwd: '/home/dev/infra', branch: 'main',
    title: 'etcd-quorum', day: '2026-08-19', id: 'f6071829-3041-4fde-93a0-245678901235',
    turns: [
      ['lost the API server when I rebooted one control plane node',
       'One node out of three should not cost you the API. Checking etcd first:',
       ['Bash', { command: 'etcdctl endpoint status --cluster -w table' },
        '+-------------------------+------------------+---------+---------+-----------+\n| ENDPOINT                | ID               | VERSION | DB SIZE | IS LEADER |\n+-------------------------+------------------+---------+---------+-----------+\n| https://10.0.0.11:2379  | 8e9c4f2a1b3d5e70 | 3.5.16  |   82 MB | true      |\n+-------------------------+------------------+---------+---------+-----------+'],
       'Only one member answers, so there is no quorum: the other two were never actually joined - they run as separate single-member clusters. Rebooting the one real member takes the whole API down with it.'],
    ],
  },
];

let files = 0, lines = 0;
for (const s of SESSIONS) {
  const dir = path.join(root, s.project);
  fs.mkdirSync(dir, { recursive: true });
  const out = [];
  const at = (h, m) => `${s.day}T${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00.000Z`;
  const base = { sessionId: s.id, cwd: s.cwd, gitBranch: s.branch, version: '2.0.31', userType: 'external', isSidechain: false };
  out.push(JSON.stringify({ type: 'ai-title', aiTitle: s.title, sessionId: s.id }));
  let h = 9, m = 12, prev = null;
  for (const [ask, say, tool, close] of s.turns) {
    const u = uuid();
    out.push(JSON.stringify({ ...base, type: 'user', uuid: u, parentUuid: prev, timestamp: at(h, m),
      message: { role: 'user', content: [{ type: 'text', text: ask }] } }));
    const a1 = uuid();
    out.push(JSON.stringify({ ...base, type: 'assistant', uuid: a1, parentUuid: u, timestamp: at(h, m + 1),
      message: { role: 'assistant', content: [{ type: 'text', text: say }] } }));
    const tu = uuid();
    out.push(JSON.stringify({ ...base, type: 'assistant', uuid: tu, parentUuid: a1, timestamp: at(h, m + 1),
      message: { role: 'assistant', content: [{ type: 'tool_use', id: `toolu_${tu}`, name: tool[0], input: tool[1] }] } }));
    out.push(JSON.stringify({ ...base, type: 'user', uuid: uuid(), parentUuid: tu, timestamp: at(h, m + 2),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${tu}`, content: [{ type: 'text', text: tool[2] }] }] } }));
    const a2 = uuid();
    out.push(JSON.stringify({ ...base, type: 'assistant', uuid: a2, parentUuid: tu, timestamp: at(h, m + 3),
      message: { role: 'assistant', content: [{ type: 'text', text: close }] } }));
    prev = a2; m += 9; if (m > 50) { h++; m = 5; }
  }
  fs.writeFileSync(path.join(dir, `${s.id}.jsonl`), out.join('\n') + '\n');
  files++; lines += out.length;
}
console.log(`${files} transcripts, ${lines} entries -> ${root}`);
