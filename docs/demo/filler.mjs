import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const HOME = process.argv[2];
const root = path.join(HOME, '.claude', 'projects');

const T = [
  ['webpack-slow','build takes 4 minutes locally','Checking which loaders dominate the profile.','npx webpack --profile --json | jq ".modules|length"','2841','babel-loader runs over node_modules because the exclude pattern is a string, not a regexp.'],
  ['eslint-rule','eslint complains about an import order I did not change','The plugin bumped its default group ordering in a minor release.','npx eslint --print-config src/index.js | jq ".rules[\\"import/order\\"]"','[ "error", { "groups": [ "builtin", "external", "internal" ] } ]','Pin the plugin or spell the groups out explicitly; the default changed under you.'],
  ['pytest-fixture','fixture runs once per test instead of once per module','Scope is the usual cause.','pytest --setup-show tests/test_api.py | head -3','SETUP    F db_conn\nSETUP    F db_conn','It is function-scoped. Pass scope="module" and take the fixture from a module-level conftest.'],
  ['poetry-lock','poetry install pulls a version the lockfile does not list','The lockfile is stale relative to the constraints.','poetry lock --check','Error: pyproject.toml changed significantly since poetry.lock was generated','Regenerate the lock in the same commit as the constraint change, and commit both.'],
  ['nginx-gzip','responses are not compressed for the API','gzip_types does not include the JSON mime type by default.','curl -sI -H "Accept-Encoding: gzip" https://api.local/v1/ping | grep -i content-encoding','','Add application/json to gzip_types; text/html is the only default.'],
  ['redis-eviction','cache keys vanish before their TTL','That is eviction, not expiry.','redis-cli info memory | grep -E "maxmemory_policy|used_memory_human"','used_memory_human:3.98G\nmaxmemory_policy:allkeys-lru','You are at the memory ceiling, so LRU drops live keys. Raise maxmemory or shrink the value size.'],
  ['s3-lifecycle','old objects are not being deleted','The rule applies to a prefix that no longer matches the layout.','aws s3api get-bucket-lifecycle-configuration --bucket assets | jq ".Rules[].Filter"','{ "Prefix": "tmp/" }','Objects moved under uploads/tmp/ last quarter, so the rule matches nothing.'],
  ['tf-state-lock','terraform apply says the state is locked','A previous run died without releasing it.','terraform force-unlock -force 8f2c1d','Terraform state has been successfully unlocked!','Unlocked. Add a CI trap so an interrupted run always releases the lock.'],
  ['git-rebase','rebase keeps replaying the same conflict','The same change exists on both sides with different whitespace.','git rebase --onto main feature~3 feature','Auto-merging src/app.py\nCONFLICT (content): Merge conflict in src/app.py','Normalise the whitespace in one commit first, then the rebase is clean.'],
  ['docker-cache','every build reinstalls dependencies','The COPY of the whole tree invalidates the layer.','docker build --progress plain . 2>&1 | grep -c CACHED','1','Copy the manifest first, install, then copy the source. Standard two-step layer split.'],
  ['grafana-var','dashboard variable is empty on load','The query returns labels the datasource has not seen yet.','curl -s localhost:3000/api/datasources/proxy/1/api/v1/labels | jq ".data|length"','0','The datasource points at an empty tenant; the variable query is fine.'],
  ['prom-relabel','a metric label is missing after scrape','A relabel rule drops it before ingestion.','promtool check config prometheus.yml','SUCCESS: prometheus.yml is valid prometheus config file syntax','Config is valid, but labeldrop removes instance. Reorder the rules.'],
  ['kafka-lag','consumer lag grows on one partition only','That partition has a hot key.','kafka-consumer-groups --describe --group orders | sort -k5 -n | tail -2','orders 7  914233  1041882  127649','One key dominates partition 7. Add the tenant to the partition key.'],
  ['pg-vacuum','table keeps growing though rows are deleted','Autovacuum cannot keep up with the churn.','psql -c "select relname, n_dead_tup from pg_stat_user_tables order by 2 desc limit 2"','events | 4812339','Dead tuples are not being reclaimed. Lower the scale factor for this table.'],
  ['mysql-charset','emoji come back as question marks','The column is utf8, not utf8mb4.','mysql -e "show full columns from comments like \\"body\\""','body | text | utf8_general_ci','Three-byte utf8 cannot hold an emoji. Convert the column and the connection charset.'],
  ['rabbit-dlq','messages pile up in the dead letter queue','Consumers reject without requeue on a parse error.','rabbitmqctl list_queues name messages | grep dlq','orders.dlq  18422','Every malformed payload lands here forever. Add a poison-message limit.'],
  ['jwt-skew','token rejected as expired right after issue','Clock skew between issuer and verifier.','date -u; ssh api date -u','Mon Aug 11 09:14:02 UTC 2026\nMon Aug 11 09:16:41 UTC 2026','Two and a half minutes apart. Allow leeway, and fix ntp on the API host.'],
  ['oauth-redirect','provider returns redirect_uri_mismatch','The registered URI has a trailing slash and the request does not.','curl -s "$ISSUER/.well-known/openid-configuration" | jq -r .issuer','https://auth.example.com','Exact string match, so the slash matters. Register both or normalise the client.'],
  ['cors-preflight','browser blocks the request but curl works','curl never sends a preflight.','curl -sI -X OPTIONS -H "Origin: https://app.local" https://api.local/v1/orders | head -3','HTTP/2 405','OPTIONS is not routed, so the preflight fails. Handle it before auth middleware.'],
  ['ws-ping','websocket drops after 60 seconds idle','A proxy in front closes idle connections.','curl -sI https://api.local | grep -i server','server: nginx','proxy_read_timeout is 60s. Send an application ping, or raise the timeout.'],
  ['swift-build','archive fails but debug builds fine','A dependency is missing a release configuration.','xcodebuild -showBuildSettings -configuration Release | grep SWIFT_OPT','SWIFT_OPTIMIZATION_LEVEL = -O','Whole-module optimisation exposes an unchecked cast the debug build tolerates.'],
  ['gradle-daemon','gradle rebuilds everything each time','The daemon dies between runs, so the build cache is cold.','./gradlew --status','No Gradle daemons are running.','Memory limit kills it. Raise the daemon heap in gradle.properties.'],
  ['npm-audit','audit reports a vulnerability with no upgrade path','It is a transitive pin two levels down.','npm ls minimist --all | head -3','app@1.0.0\n  mkdirp@0.5.1\n    minimist@0.0.8','Override the transitive version rather than waiting for the parent to release.'],
  ['yarn-resolutions','two copies of the same library end up in the bundle','Different ranges resolve to different versions.','yarn why react-dom | grep -c "Found"','2','Add a resolution so both dependents share one copy.'],
  ['sqlite-wal','readers block writers on a busy file','Journal mode is still the default.','sqlite3 app.db "pragma journal_mode"','delete','Switch to WAL. Readers and one writer then run concurrently.'],
  ['es-mapping','a field is not searchable after reindex','Dynamic mapping guessed keyword.','curl -s localhost:9200/logs/_mapping | jq ".logs.mappings.properties.message.type"','"keyword"','Keyword is not analysed, so full-text queries miss. Declare it as text explicitly.'],
  ['logstash-grok','half the lines end up in _grokparsefailure','Two log formats share one pipeline.','grep -c _grokparsefailure /var/log/logstash/out.log','4471','The second format has a different timestamp layout. Add a second match pattern.'],
  ['ansible-idempotent','playbook reports changed on every run','A shell task with no creates guard.','ansible-playbook site.yml --check --diff | grep -c changed','6','Six tasks are unconditional shell calls. Give each a creates or a when.'],
  ['make-phony','make skips a target that should always run','A file of the same name exists.','ls -l test','-rw-r--r--  1 dev  staff  0 Aug 14 11:02 test','Declare it .PHONY, or the empty file satisfies the target.'],
  ['cron-tz','job runs an hour late half the year','cron uses the system timezone, which observes DST.','systemctl show -p Timezone systemd-timedated','Timezone=Europe/Berlin','Use UTC for the schedule, or a systemd timer with an explicit timezone.'],
  ['systemd-timer','timer never fires after the first run','Persistent is set without an accuracy window.','systemctl list-timers backup.timer --all','n/a  n/a  backup.timer  backup.service','The calendar spec parsed to a date in the past. Fix OnCalendar.'],
  ['acme-ratelimit','certificate issuance refused for the rest of the week','Too many identical orders.','curl -s https://acme.example.com/directory | jq -r .meta.website','https://letsencrypt.org','Duplicate-certificate limit hit by a retry loop. Back off and reuse the existing cert.'],
  ['ssh-agent','agent forwarding stops working through a jump host','ForwardAgent is set for the wrong host block.','ssh -G bastion | grep forwardagent','forwardagent no','The wildcard block below overrides it. Move the specific block first.'],
  ['rsync-delete','rsync deleted files it should have kept','--delete with a filter that excludes them from the source list.','rsync -n -av --delete src/ dst/ | head -3','deleting dst/keep/old.bin','Excluded paths look absent to rsync, so delete removes them. Use --delete-excluded deliberately or not at all.'],
  ['tar-sparse','archive is far bigger than the files it holds','Sparse files are stored expanded.','tar -tvf backup.tar | head -2','-rw-r--r-- dev/staff 21474836480 2026-08-19 disk.img','A 20G sparse image is written in full. Add -S.'],
  ['jq-filter','jq returns null for a field that clearly exists','The field sits inside an array.','jq ".items[0].metadata.name" pods.json','"api-7f9c"','Index into the array first; the top-level object has no metadata.'],
];

const PROJ = ['-home-dev-web','-home-dev-api','-home-dev-data','-home-dev-tools'];
const CWD = { '-home-dev-web': '/home/dev/web', '-home-dev-api': '/home/dev/api', '-home-dev-data': '/home/dev/data', '-home-dev-tools': '/home/dev/tools' };
const BR = ['main', 'stage', 'main', 'develop'];

let n = 0, lines = 0;
T.forEach(([title, ask, say, cmd, out, close], i) => {
  const project = PROJ[i % PROJ.length];
  const h = crypto.createHash('sha256').update(title).digest('hex');
  const id = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
  const day = `2026-0${6 + (i % 3)}-${String(2 + (i % 26)).padStart(2, '0')}`;
  const base = { sessionId: id, cwd: CWD[project], gitBranch: BR[i % BR.length], version: '2.0.31', userType: 'external', isSidechain: false };
  const at = (m) => `${day}T1${i % 4}:${String(10 + m).padStart(2, '0')}:00.000Z`;
  const o = [JSON.stringify({ type: 'ai-title', aiTitle: title, sessionId: id })];
  o.push(JSON.stringify({ ...base, type: 'user', uuid: `u${id}`, parentUuid: null, timestamp: at(0), message: { role: 'user', content: [{ type: 'text', text: ask }] } }));
  o.push(JSON.stringify({ ...base, type: 'assistant', uuid: `a${id}`, parentUuid: `u${id}`, timestamp: at(1), message: { role: 'assistant', content: [{ type: 'text', text: say }] } }));
  o.push(JSON.stringify({ ...base, type: 'assistant', uuid: `t${id}`, parentUuid: `a${id}`, timestamp: at(1), message: { role: 'assistant', content: [{ type: 'tool_use', id: `toolu_${id}`, name: 'Bash', input: { command: cmd } }] } }));
  o.push(JSON.stringify({ ...base, type: 'user', uuid: `r${id}`, parentUuid: `t${id}`, timestamp: at(2), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${id}`, content: [{ type: 'text', text: out }] }] } }));
  o.push(JSON.stringify({ ...base, type: 'assistant', uuid: `z${id}`, parentUuid: `t${id}`, timestamp: at(3), message: { role: 'assistant', content: [{ type: 'text', text: close }] } }));
  const dir = path.join(root, project);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), o.join('\n') + '\n');
  n++; lines += o.length;
});
console.log(`filler: ${n} transcripts, ${lines} entries`);
