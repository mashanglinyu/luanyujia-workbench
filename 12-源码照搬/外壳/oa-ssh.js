// oa-ssh.js — OA 运维场景的 SSH 通道（paramiko 桥接，复用云控台已验证的连接方式）
// 服务器信息：优先 oa.db 配置；自动从 云控台/config.json（<客户>教育 oa 项目）导入，仅填空缺项
// 密码来源：1) 环境变量 SSH_PASS（与云控台一致，不落盘，推荐） 2) oa.db 配置 ssh.credential（可选）
// 全部数据读写均在 D 盘，绝不落 C 盘。
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const oaStore = require('./oa-store');

const PYTHON = process.env.PYTHON || 'python';
const YUNKONGTAI_CFG = '<资料库>';

// ---------- 从云控台 config.json 导入服务器信息（仅在 oa.db 未配置时填充） ----------
function importYunKongTaiConfig() {
  try {
    if (!fs.existsSync(YUNKONGTAI_CFG)) return;
    const cfg = JSON.parse(fs.readFileSync(YUNKONGTAI_CFG, 'utf8'));
    const s = cfg.server || {}, p = cfg.paths || {}, svc = cfg.services || {}, u = cfg.urls || {};
    const setIfEmpty = (k, v) => { if (v != null && v !== '' && !oaStore.getConfig(k)) oaStore.setConfig(k, String(v)); };
    setIfEmpty('ssh.host', s.host);
    setIfEmpty('ssh.port', s.port);
    setIfEmpty('ssh.user', s.user);
    setIfEmpty('ssh.auth', 'password');
    setIfEmpty('oa.path.code', p.server_code);
    setIfEmpty('oa.path.www', p.server_www);
    setIfEmpty('oa.path.backups', p.server_backup_dir);
    setIfEmpty('oa.path.local', p.local_project);
    setIfEmpty('oa.svc.backend', svc.backend);
    setIfEmpty('oa.svc.nginx', svc.nginx);
    setIfEmpty('oa.svc.mysql', svc.mysql);
    Object.keys(u).forEach(k => setIfEmpty('oa.url.' + k, u[k]));
  } catch (e) { /* 忽略：云控台不可用时不影响 */ }
}
importYunKongTaiConfig();

// ---------- 配置读取 ----------
// getConn：内部使用（含密码，仅在本模块内传递，经子进程环境变量走）
// getConfig：对外安全视图（不返回密码），供 oa:ssh:status 展示
// ---------- 场景级配置覆盖（多公司模板支持）----------
// 场景 json 里的 meta 可覆盖：SSH 连接、服务名/pm2 名、同步映射、日志来源
// meta 缺省时**全部回落到 oa.db 的全局配置** → 原有场景（<客户>）行为完全不变
let scMeta = null;
function setMeta(m) { scMeta = (m && typeof m === 'object') ? m : null; }
function meta() { return scMeta || {}; }

function getConn() {
  const ms = meta().ssh || {};
  const host = ms.host || oaStore.getConfig('ssh.host') || '';
  const port = Number(ms.port || oaStore.getConfig('ssh.port') || 22) || 22;
  const user = ms.user || oaStore.getConfig('ssh.user') || '';
  const envKey = ms.envKey || 'SSH_PASS';
  const envPw = process.env[envKey] || process.env.SSH_PASS || '';
  const credKey = ms.credentialKey || 'ssh.credential';
  const dbPw = oaStore.getConfig(credKey) || oaStore.getConfig('ssh.credential') || '';
  const password = envPw || dbPw;
  return {
    host, port, user,
    auth: ms.auth || oaStore.getConfig('ssh.auth') || 'password',
    password,
    passwordSet: !!password,
    envSource: !!envPw
  };
}
function getConfig() {
  const c = getConn();
  return {
    host: c.host, port: c.port, user: c.user, auth: c.auth,
    passwordSet: c.passwordSet, envSource: c.envSource
  };
}
function isReady() {
  const c = getConn();
  return !!(c.host && c.user && c.passwordSet);
}

// ---------- 通用 SSH 执行（密码经子进程环境变量传递，不进命令行） ----------
// python 脚本：读取 argv 里的 host/port/user/cmd，从 env SSH_PASS 取密码
function sshExec(command, timeoutMs) {
  const t = Math.max(5000, Number(timeoutMs) || 60000);
  return new Promise((resolve) => {
    const cfg = getConn();
    if (!cfg.host || !cfg.user) return resolve({ ok: false, err: '未配置服务器（ssh.host / ssh.user）' });
    if (!cfg.passwordSet) return resolve({ ok: false, err: '未配置密码：设置环境变量 SSH_PASS，或在 OA 配置填写 ssh.credential' });
    const script = `
import json, os, sys
sys.stdout.reconfigure(encoding='utf-8', errors='replace')
sys.stderr.reconfigure(encoding='utf-8', errors='replace')
import paramiko
host = sys.argv[1]
port = int(sys.argv[2])
user = sys.argv[3]
cmd = sys.argv[4] if len(sys.argv) > 4 else ''
pw = os.environ.get('SSH_PASS', '')
try:
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(hostname=host, port=port, username=user, password=pw, timeout=15, look_for_keys=False, allow_agent=False)
    stdin, stdout, stderr = c.exec_command(cmd, timeout=${Math.floor(t / 1000)})
    out = stdout.read().decode('utf-8', 'replace')
    err = stderr.read().decode('utf-8', 'replace')
    code = stdout.channel.recv_exit_status()
    c.close()
    print(json.dumps({'ok': True, 'code': code, 'out': out, 'err': err}, ensure_ascii=False))
except Exception as ex:
    print(json.dumps({'ok': False, 'err': str(ex)[:600]}, ensure_ascii=False))
`;
    const env = Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8', SSH_PASS: cfg.password });
    const proc = spawn(PYTHON, ['-c', script, cfg.host, String(cfg.port), cfg.user, String(command || '')], { env, windowsHide: true });
    let out = '', err = '';
    proc.stdout.on('data', d => { out += String(d); });
    proc.stderr.on('data', d => { err += String(d); });
    const timer = setTimeout(() => { try { proc.kill(); } catch (e) { /* ignore */ } resolve({ ok: false, err: err + '\n[SSH 超时 ' + Math.floor(t / 1000) + 's]' }); }, t);
    proc.on('close', () => {
      clearTimeout(timer);
      try {
        const last = out.trim().split('\n').pop();
        const data = JSON.parse(last);
        resolve(data);
      } catch (e) { resolve({ ok: false, err: out + err }); }
    });
    proc.on('error', ex => { clearTimeout(timer); resolve({ ok: false, err: String((ex && ex.message) || ex) }); });
  });
}

// ---------- 状态采集（一次 SSH 会话批量取指标，返回 JSON） ----------
function collectStatus() {
  return new Promise((resolve) => {
    const cfg = getConn();
    if (!cfg.host || !cfg.user) return resolve({ ok: false, err: '未配置服务器（ssh.host / ssh.user）' });
    if (!cfg.passwordSet) return resolve({ ok: false, err: '未配置密码（SSH_PASS 或 ssh.credential）' });
    const script = `
import json, os, sys
sys.stdout.reconfigure(encoding='utf-8', errors='replace')
sys.stderr.reconfigure(encoding='utf-8', errors='replace')
import paramiko
host = sys.argv[1]
port = int(sys.argv[2])
user = sys.argv[3]
pw = os.environ.get('SSH_PASS', '')
def sh(c, cmd, timeout=20):
    try:
        i, o, e = c.exec_command(cmd, timeout=timeout)
        out = o.read().decode('utf-8', 'replace')
        code = o.channel.recv_exit_status()
        return out.strip(), code
    except Exception:
        return '', -1
try:
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(hostname=host, port=port, username=user, password=pw, timeout=15, look_for_keys=False, allow_agent=False)
    st = {'host': host, 'connected': True}
    out, _ = sh(c, 'hostname; uname -sr')
    lines = out.splitlines()
    hostname = lines[0] if lines else host
    st['host'] = hostname + ' (' + host + ')'
    st['hostname'] = hostname
    st['os'] = lines[1] if len(lines) > 1 else ''
    out, _ = sh(c, 'uptime -p')
    st['uptime'] = out or '--'
    cpu = None
    out, _ = sh(c, "top -bn2 | grep -i 'cpu(s)' | tail -1")
    try:
        t = out.replace('%', '')
        idle = None
        for part in t.split(','):
            part = part.strip()
            if part.endswith(' id'):
                idle = float(part.split()[0])
                break
        if idle is not None:
            cpu = round(100 - idle, 1)
    except Exception:
        pass
    st['cpu'] = cpu
    out, _ = sh(c, "free -m | awk 'NR==2{print $3, $2}'")
    parts = out.split()
    try:
        mu = float(parts[0]); mt = float(parts[1])
        st['mem'] = round(mu / mt * 100, 1) if mt > 0 else None
        st['mem_used'] = mu; st['mem_total'] = mt
    except Exception:
        st['mem'] = None
    out, _ = sh(c, "df -h / | tail -1 | awk '{print $5}'")
    try:
        st['disk'] = float(out.replace('%', '').strip())
    except Exception:
        st['disk'] = None
    services = []
    EX = json.loads(sys.argv[4]) if len(sys.argv) > 4 and sys.argv[4] else {}
    svc_names = EX.get('services') or ['nginx', 'mysql']
    pm2_name = EX.get('pm2') or 'langchen-oa'
    ports_re = EX.get('portsRe') or ':3000|:8081|:8082|:8083'
    for name in svc_names:
        o2, c2 = sh(c, 'systemctl is-active ' + name)
        services.append({'name': name, 'state': o2 or ('unknown' if c2 != 0 else 'running'), 'ok': o2 == 'active'})
    o3, _ = sh(c, 'pm2 jlist 2>/dev/null')
    pm2 = []
    try:
        arr = json.loads(o3) if o3 else []
        for a in arr:
            env2 = a.get('pm2_env') or {}
            nm = a.get('name') or ''
            if nm == pm2_name or nm == pm2_name.replace('-', '_'):
                pm2.append({'name': nm, 'state': env2.get('status', ''), 'restarts': env2.get('restart_time', 0), 'uptime_ms': env2.get('pm_uptime', 0)})
    except Exception:
        pass
    st['pm2'] = pm2
    if pm2:
        p = pm2[0]
        services.insert(0, {'name': 'backend (' + p['name'] + ')', 'state': p['state'], 'ok': p['state'] == 'online'})
    st['services'] = services
    o4, _ = sh(c, "ss -tlnp 2>/dev/null | grep -E '" + ports_re + "' | awk '{print $4}' | sort -u")
    st['ports'] = [x for x in o4.splitlines() if x.strip()] if o4 else []
    c.close()
    print(json.dumps({'ok': True, 'status': st}, ensure_ascii=False))
except Exception as ex:
    print(json.dumps({'ok': False, 'err': str(ex)[:600]}, ensure_ascii=False))
`;
    const env = Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8', SSH_PASS: cfg.password });
    const extras = JSON.stringify({
      services: (meta().svc && meta().svc.extra) || [oaStore.getConfig('oa.svc.nginx') || 'nginx', oaStore.getConfig('oa.svc.mysql') || 'mysql'],
      pm2: (meta().svc && meta().svc.backend) || oaStore.getConfig('oa.svc.backend') || 'langchen-oa',
      portsRe: (meta().status && meta().status.portsRe) || ':3000|:8081|:8082|:8083'
    });
    const proc = spawn(PYTHON, ['-c', script, cfg.host, String(cfg.port), cfg.user, extras], { env, windowsHide: true });
    let out = '', err = '';
    proc.stdout.on('data', d => { out += String(d); });
    proc.stderr.on('data', d => { err += String(d); });
    const timer = setTimeout(() => { try { proc.kill(); } catch (e) { /* ignore */ } resolve({ ok: false, err: err + '\n[状态采集超时 45s]' }); }, 45000);
    proc.on('close', () => {
      clearTimeout(timer);
      try {
        const last = out.trim().split('\n').pop();
        const data = JSON.parse(last);
        resolve(data);
      } catch (e) { resolve({ ok: false, err: out + err }); }
    });
    proc.on('error', ex => { clearTimeout(timer); resolve({ ok: false, err: String((ex && ex.message) || ex) }); });
  });
}

// ---------- SFTP 目录浏览（远程列表，按目录优先排序） ----------
function listDir(remotePath) {
  return new Promise((resolve) => {
    const cfg = getConn();
    if (!cfg.host || !cfg.user) return resolve({ ok: false, err: '未配置服务器' });
    if (!cfg.passwordSet) return resolve({ ok: false, err: '未配置密码（SSH_PASS 或 ssh.credential）' });
    const script = `
import json, os, sys, stat as stat_mod
sys.stdout.reconfigure(encoding='utf-8', errors='replace')
sys.stderr.reconfigure(encoding='utf-8', errors='replace')
import paramiko
host = sys.argv[1]; port = int(sys.argv[2]); user = sys.argv[3]
path = sys.argv[4] if len(sys.argv) > 4 else '/'
pw = os.environ.get('SSH_PASS', '')
try:
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(hostname=host, port=port, username=user, password=pw, timeout=15, look_for_keys=False, allow_agent=False)
    sftp = c.open_sftp()
    entries = []
    for a in sftp.listdir_attr(path):
        isdir = stat_mod.S_ISDIR(a.st_mode)
        entries.append({'name': a.filename, 'isDir': isdir, 'size': int(a.st_size) if not isdir else 0, 'mtime': int(a.st_mtime)})
    sftp.close(); c.close()
    entries.sort(key=lambda x: (not x['isDir'], x['name'].lower()))
    print(json.dumps({'ok': True, 'path': path, 'entries': entries}, ensure_ascii=False))
except Exception as ex:
    print(json.dumps({'ok': False, 'err': str(ex)[:500]}, ensure_ascii=False))
`;
    const env = Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8', SSH_PASS: cfg.password });
    const proc = spawn(PYTHON, ['-c', script, cfg.host, String(cfg.port), cfg.user, String(remotePath || '/')], { env, windowsHide: true });
    let out = '', err = '';
    proc.stdout.on('data', d => { out += String(d); });
    proc.stderr.on('data', d => { err += String(d); });
    const timer = setTimeout(() => { try { proc.kill(); } catch (e) { /* ignore */ } resolve({ ok: false, err: err + '\n[目录浏览超时]' }); }, 30000);
    proc.on('close', () => {
      clearTimeout(timer);
      try { resolve(JSON.parse(out.trim().split('\n').pop())); }
      catch (e) { resolve({ ok: false, err: out + err }); }
    });
    proc.on('error', ex => { clearTimeout(timer); resolve({ ok: false, err: String((ex && ex.message) || ex) }); });
  });
}

// ---------- 同步比对 ----------
// 与云控台一致：按 mtime+size 判断；排除 node_modules/.git/dist/unpackage/__pycache__/.env/*.log/.DS_Store
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'unpackage', '__pycache__']);
const SKIP_NAMES = ['.env', '.DS_Store'];
function shouldSkipName(name) {
  return SKIP_DIRS.has(name) || SKIP_NAMES.indexOf(name) >= 0 || /\.log$/i.test(name);
}
// 本地递归遍历（相对路径 → {size, mtime(秒)}）
function walkLocal(dir, base, map, depth) {
  if (depth > 14) return;
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const ent of ents) {
    if (shouldSkipName(ent.name)) continue;
    const rel = base ? base + '/' + ent.name : ent.name;
    if (ent.isDirectory()) walkLocal(path.join(dir, ent.name), rel, map, depth + 1);
    else {
      try {
        const st = fs.statSync(path.join(dir, ent.name));
        map[rel] = { size: st.size, mtime: st.mtimeMs / 1000 };
      } catch (e) { /* ignore */ }
    }
  }
}
// 云控台同步映射（本地 ↔ 云端）
// 场景 meta.mappings 可覆盖；缺省用<客户>默认四条（meta.paths 可改根目录）
function getMappings() {
  const m = meta();
  const mp = m.paths || {};
  const localRoot = mp.local || oaStore.getConfig('oa.path.local') || '<资料库>';
  const codeRoot = mp.code || oaStore.getConfig('oa.path.code') || '/opt/langchen_oa';
  const wwwRoot = mp.www || oaStore.getConfig('oa.path.www') || '/var/www';
  if (Array.isArray(m.mappings) && m.mappings.length) {
    return m.mappings.map(x => ({
      key: x.key,
      label: x.label || x.key,
      local: path.isAbsolute(String(x.local || '')) ? x.local : path.join(localRoot, String(x.local || '')),
      remote: String(x.remote || '').replace('{www}', wwwRoot).replace('{code}', codeRoot)
    }));
  }
  return [
    { key: 'backend', label: '后端', local: path.join(localRoot, 'backend'), remote: codeRoot + '/backend' },
    { key: 'admin', label: '管理后台', local: path.join(localRoot, 'web', 'dist'), remote: wwwRoot + '/admin' },
    { key: 'teacher', label: '教师端', local: path.join(localRoot, '打包产物', '教师端', 'H5网页版'), remote: wwwRoot + '/teacher' },
    { key: 'parent', label: '家长端', local: path.join(localRoot, '打包产物', '家长端', 'H5网页版'), remote: wwwRoot + '/parent' }
  ];
}
// 远程递归遍历（SFTP，一次连接批量取多个根）
function syncRemoteFiles(remoteRoots) {
  return new Promise((resolve) => {
    const cfg = getConn();
    if (!cfg.host || !cfg.user) return resolve({ ok: false, err: '未配置服务器' });
    if (!cfg.passwordSet) return resolve({ ok: false, err: '未配置密码（SSH_PASS 或 ssh.credential）' });
    const rootsJson = JSON.stringify(remoteRoots || []);
    const script = `
import json, os, sys, stat as stat_mod
sys.stdout.reconfigure(encoding='utf-8', errors='replace')
sys.stderr.reconfigure(encoding='utf-8', errors='replace')
import paramiko
host = sys.argv[1]; port = int(sys.argv[2]); user = sys.argv[3]
roots = json.loads(sys.argv[4]) if len(sys.argv) > 4 else []
pw = os.environ.get('SSH_PASS', '')
SKIP_DIRS = set(['node_modules', '.git', 'dist', 'unpackage', '__pycache__'])
def skip_name(n):
    if n in SKIP_DIRS: return True
    if n in ('.env', '.DS_Store'): return True
    if n.endswith('.log'): return True
    return False
def walk(sftp, root, base, d):
    try:
        attrs = sftp.listdir_attr(root)
    except Exception:
        return
    for a in attrs:
        if skip_name(a.filename): continue
        rel = (base + '/' + a.filename).lstrip('/') if base else a.filename
        if stat_mod.S_ISDIR(a.st_mode):
            walk(sftp, root.rstrip('/') + '/' + a.filename, rel, d)
        else:
            d[rel] = {'size': int(a.st_size), 'mtime': float(a.st_mtime)}
try:
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(hostname=host, port=port, username=user, password=pw, timeout=15, look_for_keys=False, allow_agent=False)
    sftp = c.open_sftp()
    result = {}
    for root in roots:
        try:
            d = {}
            walk(sftp, root, '', d)
            result[root] = d
        except Exception:
            result[root] = None
    sftp.close(); c.close()
    print(json.dumps({'ok': True, 'files': result}, ensure_ascii=False))
except Exception as ex:
    print(json.dumps({'ok': False, 'err': str(ex)[:500]}, ensure_ascii=False))
`;
    const env = Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8', SSH_PASS: cfg.password });
    const proc = spawn(PYTHON, ['-c', script, cfg.host, String(cfg.port), cfg.user, rootsJson], { env, windowsHide: true });
    let out = '', err = '';
    proc.stdout.on('data', d => { out += String(d); });
    proc.stderr.on('data', d => { err += String(d); });
    const timer = setTimeout(() => { try { proc.kill(); } catch (e) { /* ignore */ } resolve({ ok: false, err: err + '\n[同步比对超时]' }); }, 60000);
    proc.on('close', () => {
      clearTimeout(timer);
      try { resolve(JSON.parse(out.trim().split('\n').pop())); }
      catch (e) { resolve({ ok: false, err: out + err }); }
    });
    proc.on('error', ex => { clearTimeout(timer); resolve({ ok: false, err: String((ex && ex.message) || ex) }); });
  });
}
// 同步状态：逐映射比对本地/云端，得出需推送/需拉取清单（mtime 容差 90s）
function syncStatus() {
  return new Promise(async (resolve) => {
    const mappings = getMappings();
    const r = await syncRemoteFiles(mappings.map(m => m.remote));
    if (!r.ok) return resolve({ ok: false, err: r.err });
    const files = r.files || {};
    const out = mappings.map(m => {
      const localExists = fs.existsSync(m.local);
      const rmap = files[m.remote];
      const base = { key: m.key, label: m.label, local: m.local, remote: m.remote };
      if (!localExists) return Object.assign(base, { status: 'missing-local', inSync: false });
      if (rmap === undefined) return Object.assign(base, { status: 'missing-remote', inSync: false });
      const lmap = {};
      walkLocal(m.local, '', lmap, 0);
      const push = [], pull = [];
      const TOL = 90;   // 秒
      Object.keys(lmap).forEach(p => {
        const l = lmap[p], r2 = rmap[p];
        if (!r2) { push.push(p); }
        else if (l.size !== r2.size || Math.abs(l.mtime - r2.mtime) > TOL) {
          (l.mtime > r2.mtime ? push : pull).push(p);
        }
      });
      Object.keys(rmap).forEach(p => { if (!lmap[p]) pull.push(p); });
      return Object.assign(base, {
        status: (push.length || pull.length) ? 'pending' : 'in-sync',
        inSync: push.length === 0 && pull.length === 0,
        localCount: Object.keys(lmap).length,
        remoteCount: Object.keys(rmap).length,
        push: push.slice(0, 50),
        pull: pull.slice(0, 50),
        pushTotal: push.length,
        pullTotal: pull.length
      });
    });
    resolve({ ok: true, mappings: out, time: new Date().toISOString() });
  });
}

// ---------- 真实日志抓取（pm2 后端 / nginx / mysql；一次连接批量 tail） ----------
const LOG_LABELS = { backend: '后端', nginx: '站点访问', 'nginx-error': '站点错误', mysql: 'MySQL' };
// 日志来源：场景 meta.logs 优先；缺省按 oa.svc.backend 推 pm2 日志路径（与<客户>原行为一致）
function logFiles() {
  const m = meta();
  if (m.logs && typeof m.logs === 'object' && Object.keys(m.logs).length) return m.logs;
  const backend = (m.svc && m.svc.backend) || oaStore.getConfig('oa.svc.backend') || 'langchen-oa';
  return {
    backend: ['/root/.pm2/logs/' + backend + '-out.log', '/root/.pm2/logs/' + backend + '-error.log'],
    nginx: ['/var/log/nginx/access.log'],
    'nginx-error': ['/var/log/nginx/error.log'],
    mysql: ['/var/log/mysql/error.log']
  };
}
function fetchLogs(kinds, lines) {
  return new Promise((resolve) => {
    const cfg = getConn();
    if (!cfg.host || !cfg.user) return resolve({ ok: false, err: '未配置服务器' });
    if (!cfg.passwordSet) return resolve({ ok: false, err: '未配置密码（SSH_PASS 或 ssh.credential）' });
    const ks = (kinds && kinds.length) ? kinds : ['backend', 'nginx'];
    const n = Math.max(20, Math.min(500, Number(lines) || 100));
    const script = `
import json, os, sys
sys.stdout.reconfigure(encoding='utf-8', errors='replace')
sys.stderr.reconfigure(encoding='utf-8', errors='replace')
import paramiko
host = sys.argv[1]; port = int(sys.argv[2]); user = sys.argv[3]
ks = json.loads(sys.argv[4]) if len(sys.argv) > 4 else ['backend', 'nginx']
n = int(sys.argv[5]) if len(sys.argv) > 5 else 100
FILES = json.loads(sys.argv[6]) if len(sys.argv) > 6 and sys.argv[6] else {}
pw = os.environ.get('SSH_PASS', '')
try:
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(hostname=host, port=port, username=user, password=pw, timeout=15, look_for_keys=False, allow_agent=False)
    result = {}
    for k in ks:
        out_lines = []
        for f in FILES.get(k, []):
            try:
                i, o, e = c.exec_command("tail -n %d %s 2>/dev/null || echo [%s不存在]" % (n, f, f), timeout=20)
                data = o.read().decode('utf-8', 'replace')
                out_lines.extend(data.splitlines())
            except Exception as ex:
                out_lines.append('[读取失败] ' + str(ex)[:120])
        result[k] = out_lines
    c.close()
    print(json.dumps({'ok': True, 'sources': result}, ensure_ascii=False))
except Exception as ex:
    print(json.dumps({'ok': False, 'err': str(ex)[:500]}, ensure_ascii=False))
`;
    const env = Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8', SSH_PASS: cfg.password });
    const proc = spawn(PYTHON, ['-c', script, cfg.host, String(cfg.port), cfg.user, JSON.stringify(ks), String(n), JSON.stringify(logFiles())], { env, windowsHide: true });
    let out = '', err = '';
    proc.stdout.on('data', d => { out += String(d); });
    proc.stderr.on('data', d => { err += String(d); });
    const timer = setTimeout(() => { try { proc.kill(); } catch (e) { /* ignore */ } resolve({ ok: false, err: err + '\n[日志抓取超时]' }); }, 30000);
    proc.on('close', () => {
      clearTimeout(timer);
      try { resolve(JSON.parse(out.trim().split('\n').pop())); }
      catch (e) { resolve({ ok: false, err: out + err }); }
    });
    proc.on('error', ex => { clearTimeout(timer); resolve({ ok: false, err: String((ex && ex.message) || ex) }); });
  });
}

// ---------- 一键推送 / 拉取（与云控台 server_ctl.py 同规则：SFTP 增量，mtime+size 容差 2s，排除表一致） ----------
function syncTransfer(mode, key) {
  return new Promise((resolve) => {
    const cfg = getConn();
    if (!cfg.host || !cfg.user) return resolve({ ok: false, err: '未配置服务器' });
    if (!cfg.passwordSet) return resolve({ ok: false, err: '未配置密码（SSH_PASS 或 ssh.credential）' });
    const m = getMappings().find(x => x.key === key);
    if (!m) return resolve({ ok: false, err: '未知同步项: ' + key });
    let exclude = [];
    try {
      const y = JSON.parse(fs.readFileSync(YUNKONGTAI_CFG, 'utf8'));
      exclude = (y.sync && y.sync.exclude) || [];
    } catch (e) { /* 使用默认排除表 */ }
    if (!exclude.length) exclude = ['node_modules', '.git', 'dist', 'unpackage', '__pycache__', '.env', '*.log', '.DS_Store'];
    const script = `
import json, os, sys, stat as stat_mod
sys.stdout.reconfigure(encoding='utf-8', errors='replace')
sys.stderr.reconfigure(encoding='utf-8', errors='replace')
import paramiko
host = sys.argv[1]; port = int(sys.argv[2]); user = sys.argv[3]
mode = sys.argv[4]; local_dir = sys.argv[5]; remote_dir = sys.argv[6]
exclude = json.loads(sys.argv[7]) if len(sys.argv) > 7 else []
pw = os.environ.get('SSH_PASS', '')
def should_skip(name):
    for pat in exclude:
        if pat.startswith('*') and name.endswith(pat[1:]): return True
        if name == pat: return True
    return False
def mkdirs(sftp, path):
    cur = ''
    for p in path.strip('/').split('/'):
        if not p: continue
        cur += '/' + p
        try: sftp.stat(cur)
        except FileNotFoundError: sftp.mkdir(cur)
changed = []
try:
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(hostname=host, port=port, username=user, password=pw, timeout=15, look_for_keys=False, allow_agent=False)
    sftp = c.open_sftp()
    if mode == 'push':
        if not os.path.isdir(local_dir):
            raise Exception('本地目录不存在: ' + local_dir)
        mkdirs(sftp, remote_dir)
        for dirpath, dirnames, filenames in os.walk(local_dir):
            dirnames[:] = [d for d in dirnames if not should_skip(d)]
            for fn in filenames:
                if should_skip(fn): continue
                rel = os.path.relpath(os.path.join(dirpath, fn), local_dir).replace('\\\\', '/')
                lpath = os.path.join(dirpath, fn)
                rpath = remote_dir.rstrip('/') + '/' + rel
                st = os.stat(lpath)
                need = True
                try:
                    rs = sftp.stat(rpath)
                    if rs.st_size == st.st_size and abs(rs.st_mtime - st.st_mtime) < 2:
                        need = False
                except FileNotFoundError:
                    need = True
                if need:
                    mkdirs(sftp, os.path.dirname(rpath))
                    sftp.put(lpath, rpath)
                    sftp.utime(rpath, (st.st_mtime, st.st_mtime))
                    changed.append(rel)
    else:
        os.makedirs(local_dir, exist_ok=True)
        def rec(rdir, ldir):
            try:
                entries = sftp.listdir_attr(rdir)
            except FileNotFoundError:
                return
            for e in entries:
                if should_skip(e.filename): continue
                rpath = rdir.rstrip('/') + '/' + e.filename
                lpath = os.path.join(ldir, e.filename)
                if stat_mod.S_ISDIR(e.st_mode):
                    os.makedirs(lpath, exist_ok=True)
                    rec(rpath, lpath)
                else:
                    need = True
                    if os.path.exists(lpath):
                        ls = os.path.getsize(lpath); lm = os.path.getmtime(lpath)
                        if ls == e.st_size and abs(lm - e.st_mtime) < 2:
                            need = False
                    if need:
                        sftp.get(rpath, lpath)
                        os.utime(lpath, (e.st_mtime, e.st_mtime))
                        changed.append(os.path.relpath(lpath, local_dir).replace('\\\\', '/'))
        rec(remote_dir, local_dir)
    sftp.close(); c.close()
    print(json.dumps({'ok': True, 'mode': mode, 'changed': changed[:200], 'total': len(changed)}, ensure_ascii=False))
except Exception as ex:
    print(json.dumps({'ok': False, 'err': str(ex)[:500]}, ensure_ascii=False))
`;
    const env = Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8', SSH_PASS: cfg.password });
    const proc = spawn(PYTHON, ['-c', script, cfg.host, String(cfg.port), cfg.user, mode, m.local, m.remote, JSON.stringify(exclude)], { env, windowsHide: true });
    let out = '', err = '';
    proc.stdout.on('data', d => { out += String(d); });
    proc.stderr.on('data', d => { err += String(d); });
    const timer = setTimeout(() => { try { proc.kill(); } catch (e) { /* ignore */ } resolve({ ok: false, err: err + '\n[同步超时 120s]' }); }, 120000);
    proc.on('close', () => {
      clearTimeout(timer);
      try { resolve(JSON.parse(out.trim().split('\n').pop())); }
      catch (e) { resolve({ ok: false, err: out + err }); }
    });
    proc.on('error', ex => { clearTimeout(timer); resolve({ ok: false, err: String((ex && ex.message) || ex) }); });
  });
}


// ---------- 单个文件上传 / 下载（与 listDir 同模式：python + paramiko SFTP）----------
function sftpOnce(script, args, timeoutMs) {
  return new Promise((resolve) => {
    const cfg = getConn();
    if (!cfg.host || !cfg.user) return resolve({ ok: false, err: '未配置服务器' });
    if (!cfg.passwordSet) return resolve({ ok: false, err: '未配置密码（SSH_PASS 或 ssh.credential）' });
    const env = Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8', SSH_PASS: cfg.password });
    const proc = spawn(PYTHON, ['-c', script, cfg.host, String(cfg.port), cfg.user].concat(args || []), { env, windowsHide: true });
    let out = '', err = '';
    proc.stdout.on('data', d => { out += String(d); });
    proc.stderr.on('data', d => { err += String(d); });
    const timer = setTimeout(() => { try { proc.kill(); } catch (e) {} resolve({ ok: false, err: err + '\n[超时]' }); }, timeoutMs || 120000);
    proc.on('close', () => {
      clearTimeout(timer);
      try { resolve(JSON.parse(out.trim().split('\n').pop())); } catch (e) { resolve({ ok: false, err: (out + err).slice(-800) }); }
    });
    proc.on('error', ex => { clearTimeout(timer); resolve({ ok: false, err: String((ex && ex.message) || ex) }); });
  });
}

const PY_HEAD = `
import json, os, sys
sys.stdout.reconfigure(encoding='utf-8', errors='replace')
import paramiko
host = sys.argv[1]; port = int(sys.argv[2]); user = sys.argv[3]
pw = os.environ.get('SSH_PASS', '')
try:
    c = paramiko.SSHClient(); c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(hostname=host, port=port, username=user, password=pw, timeout=20, look_for_keys=False, allow_agent=False)
    sftp = c.open_sftp()
`;

// 把本地文件上传到云端目录（PUT）
function putFile(localPath, remoteDir) {
  const script = `
import json, os, sys
sys.stdout.reconfigure(encoding='utf-8', errors='replace')
import paramiko
host = sys.argv[1]; port = int(sys.argv[2]); user = sys.argv[3]
local = sys.argv[4]; rdir = sys.argv[5].rstrip('/')
pw = os.environ.get('SSH_PASS', '')
try:
    name = local.replace(chr(92), '/').split('/')[-1]
    target = rdir + '/' + name
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(hostname=host, port=port, username=user, password=pw, timeout=20, look_for_keys=False, allow_agent=False)
    sftp = c.open_sftp()
    sftp.put(local, target)
    st = sftp.stat(target)
    sftp.close(); c.close()
    print(json.dumps({'ok': True, 'remote': target, 'name': name, 'size': int(st.st_size)}, ensure_ascii=False))
except Exception as ex:
    print(json.dumps({'ok': False, 'err': str(ex)[:500]}, ensure_ascii=False))
`;
  return sftpOnce(script, [localPath, remoteDir || '/tmp'], 180000);
}

// 把云端文件下载到本地目录（GET）
function getFile(remotePath, localDir) {
  const script = `
import json, os, sys
sys.stdout.reconfigure(encoding='utf-8', errors='replace')
import paramiko
host = sys.argv[1]; port = int(sys.argv[2]); user = sys.argv[3]
remote = sys.argv[4]; ldir = sys.argv[5]
pw = os.environ.get('SSH_PASS', '')
try:
    name = remote.split('/')[-1]
    if not os.path.isdir(ldir):
        os.makedirs(ldir, exist_ok=True)
    target = os.path.join(ldir, name)
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(hostname=host, port=port, username=user, password=pw, timeout=20, look_for_keys=False, allow_agent=False)
    sftp = c.open_sftp()
    sftp.get(remote, target)
    sftp.close(); c.close()
    print(json.dumps({'ok': True, 'local': target, 'name': name, 'size': int(os.path.getsize(target))}, ensure_ascii=False))
except Exception as ex:
    print(json.dumps({'ok': False, 'err': str(ex)[:500]}, ensure_ascii=False))
`;
  return sftpOnce(script, [remotePath, localDir || '<资料库>'], 180000);
}

module.exports = { getConfig, isReady, exec: sshExec, collectStatus, listDir, getMappings, syncStatus, fetchLogs, syncTransfer, setMeta, meta, putFile, getFile };
