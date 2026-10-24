#!/usr/bin/env node
// 负载闸.mjs —— ★ 用户 2026-10-16 定的硬规矩的**机械闸门**：负载太高就不许再派活。
//
// 用户原话（2026-10-16 23:4x，原样抄录，⛔ 别改写）：
//   「现在定下一个规矩，系统内存以及cpu大于90的时候不可以再派子代理或者让助理ai干活，
//     不然电脑卡爆了，严格控制cpu占用和内存不超过95」
//
// ─────────────────────────────────────────────────────────────────────────────
// 判据（**写死在这里，别处不许再定义一套**）：
//   CPU  = **采样 3 次、间隔 1.5 s、取均值**（单次采样太抖 —— 这条是用户定的，别改成单次）。
//   内存 = `(总量 − 可用) / 总量`，用 Node 的 `os.totalmem()/os.freemem()` **即时同步读**
//          （⛔ 不等 PowerShell：内存这条判据不能依赖子进程能不能起来；PS 那句
//           `(TotalVisibleMemorySize − FreePhysicalMemory)/TotalVisibleMemorySize` 的结果同时收进
//           `--json` 的 `anchorRam` 当**旁证**，两处同量级即口径自证）。
//   · CPU 与内存**都 < 90%**          ⇒ `✓ 可派单`   → 退出码 **0**
//   · **任一 ≥ 90%**（且都 <95%）      ⇒ `⚠ 停止派单` → 退出码 **10**
//        不许派子代理、不许 `--wake` 叫醒别的 AI（`通知场景.mjs` / `派单.mjs` 已接这道闸）
//   · **任一 ≥ 95%**                  ⇒ `⛔ 停重活`   → 退出码 **20**
//        连体检/批量/构建/全盘扫描这类重活也别跑，先报告用户
//   ⚠ `ok` / `warn` / `stop` 一字一词都只在这里定义：调用方只认退出码 0/10/20（别自己再算一遍）
//
// ★ 口径为什么是这样（2026-10-16 23:5x 实测，⛔ 别凭感觉"还原成 WMI 三次"）：
//   原定写法是"3 次 `Get-CimInstance Win32_Processor` 取 LoadPercentage" —— 实测**单次这个 WMI 调用
//   要 1.05~1.33 s**（Windows 每次都要重算，预热过也一样；`Get-WmiObject`/CIM query 变体都不快），
//   3 次 = 3.2 s 查询 + 3.0 s 睡眠 ≈ **7.8 s**（实测总耗时），把用户要的"全程 <4 s"顶破了。
//   现方案（两边量的是同一件事，代价最小且都自证）：
//     ① **CPU 主体**：Node `os.cpus()` 的累计 tick 差分 —— 一次采样 ≈0 ms，能在**精确的 0 / 1.5 / 3.0 s**
//        三个时刻真采样（正是用户要的"3 次 × 1.5 s 间隔"），全程只花 3.0 s；`samples=[s1,s2,s3]`。
//     ② **WMI 锚点（旁证）**：同时**后台**起一个 PowerShell 拿一次 `Win32_Processor.LoadPercentage`（口径点名的那个数）
//        + PS 口径的内存 + top 进程；采样结束再等它 700 ms，**到点就杀掉**（实测冷启动的 WMI 要 2~7 s，
//        不能为旁证把 <4 s 顶破）。拿得到就填 `anchor` / `anchorRam` / `top`，拿不到就 `anchor=null` + 打一句 ⚠，
//        **退出码照常**（判据只认 `cpu`/`ram`，两者都来自 Node 本进程，不依赖子进程）。
//     ⇒ 实跑：`cpu`（3 次均值）与 `anchor`（WMI 单点）同量级（实测 53.5 vs 43~50，同一时刻两个口径的正常差别）。
//
// ⛔ 本工具**只读**：不写任何文件、不改任何设置、不杀任何进程（唯一输出是 stdout）。
// ⚡ 开销：全程约 **3.2~4.0 s**（3.0 s 是采样本身，剩下是 Node 启动；WMI 锚点在后台并行，不额外占时间）。
//     ⚠ 本机是 Windows PowerShell 5.1：中文经命令行传进去会乱码 ⇒ 内嵌那段 PS **纯 ASCII**，
//     回包用 `[Console]::OutputEncoding=UTF8` + 子进程 `$OutputEncoding` 双保险打成 UTF-8 的 JSON 字节，
//     Node 侧当 Buffer 收、自己 `toString('utf8')`（⛔ 不用 encoding:'utf8' 直接收字符串，那会按 ANSI 解）。
//     万一运行时/脚本路径含中文导致 PS 起不来，会打 `⚠ 闸门无法判定` + 退出码 3
//     （⛔ 那是"工具跑不了"，**不是**"可以派单" —— 调用方别把 3 当 0）。
//
// 用法：
//   node 负载闸.mjs                默认：一行输出（CPU/内存 + 结论）
//   node 负载闸.mjs --json         完整 JSON：{time,cpu,ram,samples,verdict,exit,top}
//   node 负载闸.mjs --quiet        只打结论那半行（`→ ✓ 可派单`）
//   node 负载闸.mjs --min-ok 80 --min-warn 92     覆盖阈值（默认 90 / 95，⛔ 别把默认改掉）
//   node 负载闸.mjs --help
//   ⚠ 阈值注入是给"负例自测"用的（`--min-ok 1 --min-warn 2` 必然越线 ⇒ 验 warn/stop 两条路），
//     **不要**拿它去日常放宽规矩。
//
// 退出码：ok=0 · warn=10 · stop=20 · **闸门本身没跑成=3**
//   ⚠ 10/20 是"越线"，3 是"量不了" —— 两者都不是 0，调用方一律当"别派"处理最安全。
// ─────────────────────────────────────────────────────────────────────────────
import os from 'node:os';
import { spawn } from 'node:child_process';

const HELP = `负载闸.mjs —— 负载太高就不许派活（用户 2026-10-16 定：CPU/内存 >90% 不派单、>95% 停重活）

用法：
  node 负载闸.mjs                    默认一行：负载闸：CPU 25% · 内存 52% → ✓ 可派单
  node 负载闸.mjs --json             完整 JSON（含 samples 与 top：内存前 3 + CPU 秒前 3，去重）
  node 负载闸.mjs --quiet            只打结论：→ ✓ 可派单
  node 负载闸.mjs --min-ok N         把"停止派单"线从 90 改成 N（默认 90）
  node 负载闸.mjs --min-warn N       把"停重活"线从 95 改成 N（默认 95）
  node 负载闸.mjs --deep             严格模式：CPU 走 3 次真 WMI 采样（口径原文），⛔ 慢，约 7.5~9 s
  node 负载闸.mjs --help

判据（只此一处定义）：
  CPU  = 采样 3 次、间隔 1.5s、取均值（默认 os.cpus() tick 差分，精确 0/1.5/3.0s 三个时刻；
         --deep 则走 3 次 Win32_Processor.LoadPercentage）
         ＋ 后台并行拿一次 Win32_Processor.LoadPercentage 当锚点（anchor 字段，仅旁证、不参与判据）
  内存 = (总量 − 可用) / 总量（Node 即时读；PS 口径的同一个数收进 anchorRam 当旁证）
  两项都 < min-ok        ⇒ ✓ 可派单   退出码 0
  任一   ≥ min-ok(90)    ⇒ ⚠ 停止派单 退出码 10（不许派子代理 / 不许 --wake 叫醒别的 AI）
  任一   ≥ min-warn(95)  ⇒ ⛔ 停重活   退出码 20（连体检/批量/构建也别跑，先报告用户）

退出码：0=可派单 · 10=停止派单 · 20=停重活 · 3=闸门没跑成（量不了，别当成 0 用）

⛔ 只读工具：不写任何文件、不改设置、不杀进程；全程约 3.2~4.0 秒（3.0s 是采样本身）。
⚠ --min-ok/--min-warn 是给"负例自测"注入用的，别拿它日常放宽规矩。
`;

const argv = process.argv.slice(2);
const has = (n) => argv.includes(n);
if (has('--help') || has('-h')) { process.stdout.write(HELP); process.exitCode = 0; process.exit(); }
const val = (n) => {
  const i = argv.indexOf(n);
  if (i < 0) return null;
  const v = argv[i + 1];
  if (v == null || v.startsWith('--')) return NaN;
  return Number(v);
};
const MIN_OK = has('--min-ok') ? val('--min-ok') : 90;
const MIN_WARN = has('--min-warn') ? val('--min-warn') : 95;
const DEEP = has('--deep');            // 严格模式：3 次真 WMI（Get-CimInstance Win32_Processor）采样，约 7.5~9 s
const NUM = (v) => Number.isFinite(v) && v >= 0 && v <= 100;
// ⚠ `--min-warn` 额外允许多一档 **101**：本机 CPU 满载时正好 100% ⇒"只越 warn 线不越 stop 线"的用例
//   在 90/95/100 里都做不出来（100 ≥ 100 仍算 stop），101 才能把 warn 那条路单独验出来（自测专用）。
if (!NUM(MIN_OK) || !(Number.isFinite(MIN_WARN) && MIN_WARN >= 0 && MIN_WARN <= 101) || MIN_WARN < MIN_OK) {
  process.stderr.write(`✗ 阈值不合法：--min-ok=${MIN_OK} --min-warn=${MIN_WARN}（各要 0~100 的数（min-warn 允许 101，仅自测用），且 min-warn ≥ min-ok；默认 90/95）\n`);
  process.exitCode = 1;
  process.exit();
}
const SAMPLE_N = 3;
const SAMPLE_INTERVAL_MS = 1500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const arr = (v) => (Array.isArray(v) ? v : (v == null ? [] : [v]));   // ⚠ PS 5.1 单元素数组会退化成对象

function gateFail(msg) {
  process.stderr.write(`⚠ 闸门无法判定：${msg}\n   ⇒ 退出码 3（**不是**"可派单"）—— 没量到负载，调用方请按"别派"处理。\n`);
  try { if (psJob) psJob.unrefAll(); } catch {}     // 别让 PS 管道把进程吊住（见文件头 ⚡/runPs 注释）
  process.exit(3);
}

// ── ① CPU 主体：os.cpus() 累计 tick 差分，在 0 / 1.5 / 3.0 s 三个时刻真采样（≈0 ms/次） ─────────
//   `--deep` 时改走严格模式：3 次真 `Get-CimInstance Win32_Processor`（口径原文），约 7.5~9 s。
const snap = () => {
  let idle = 0, total = 0;
  for (const c of os.cpus()) { const t = c.times; const s = t.user + t.nice + t.sys + t.idle + t.irq; idle += t.idle; total += s; }
  return { idle, total, t: Date.now() };
};
const loadOf = (a, b) => {
  const dt = b.total - a.total;
  if (dt <= 0) return null;
  const busy = dt - (b.idle - a.idle);
  return Math.max(0, Math.min(100, (busy / dt) * 100));
};
async function sampleCpu() {
  const out = [];
  let prev = snap();
  for (let i = 0; i < SAMPLE_N; i++) {
    await sleep(SAMPLE_INTERVAL_MS);
    const cur = snap();
    const v = loadOf(prev, cur);
    if (v != null) out.push(Math.round(v * 10) / 10);
    prev = cur;
  }
  return out;
}
// `--deep`：3 次真 WMI（严格按口径原文，⛔ 慢但准）
const PS_DEEP = [
  "$ErrorActionPreference='SilentlyContinue'",
  '[Console]::OutputEncoding=[Text.Encoding]::UTF8',
  '$OutputEncoding=[Text.Encoding]::UTF8',
  '$s=@()',
  'for($i=0;$i -lt ' + SAMPLE_N + ';$i++){',
  '  $v=(Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average',
  '  if($v -ne $null){ $s+=[double]$v }',
  '  if($i -lt ' + (SAMPLE_N - 1) + '){ Start-Sleep -Milliseconds ' + SAMPLE_INTERVAL_MS + ' }',
  '}',
  '$o=[ordered]@{}',
  '$o.samples=@($s)',
  '$o | ConvertTo-Json -Compress -Depth 3',
].join('\n');
function runPsCmd(script, waitMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { resolve({ ok: false, err: String((e && e.message) || e) }); return; }
    const out = [];
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    child.stdout.on('data', (b) => out.push(b));
    child.on('error', (e) => finish({ ok: false, err: String((e && e.message) || e) }));
    child.on('close', (code) => finish({ ok: code === 0, code, text: Buffer.concat(out).toString('utf8'), err: '' }));
    setTimeout(() => { try { child.kill(); } catch {} finish({ ok: false, err: `超时 ${waitMs}ms` }); }, waitMs);
  });
}
async function sampleCpuDeep() {
  const r = await runPsCmd(PS_DEEP, 20000);
  if (r.ok) {
    try {
      const j = JSON.parse(String(r.text).trim());
      const a = arr(j.samples).map((v) => num(v, null)).filter((v) => v !== null);
      if (a.length) return a;
    } catch (e) { /* 掉到下面报错 */ }
  }
  gateFail(`--deep 模式 3 次 WMI 采样失败：${r.err || '回包解析失败'}`);
  return [];
}

// ── ② 后台 PowerShell：内存 + top 进程（**先吐**）＋ WMI 锚点（**后查**，慢的那一步放最后） ────────
//   ⛔ 下面这段**必须是纯 ASCII**（中文经命令行传进 powershell.exe 会乱码 ⇒ 语法错）。
//   ⚠ 顺序有讲究（2026-10-16 23:5x 实测）：`Win32_Processor` 要 1.0~1.4 s，`Get-Process` 要 ~1 s。
//     把 WMI 放**最后**、`ConvertTo-Json` 放它**前面** ⇒ 慢的 WMI 只影响 `anchor` 那个旁证字段，
//     Node 侧 **3.0 s 采样一结束就能拿到 RAM/top**（实测：顺序反过来时连 top 都拿不到）。
const PS = [
  "$ErrorActionPreference='SilentlyContinue'",
  "[Console]::OutputEncoding=[Text.Encoding]::UTF8",
  '$OutputEncoding=[Text.Encoding]::UTF8',
  '$os=Get-CimInstance Win32_OperatingSystem',
  '$tot=[double]$os.TotalVisibleMemorySize',
  '$free=[double]$os.FreePhysicalMemory',
  '$ram=0',
  'if($tot -gt 0){ $ram=[math]::Round((($tot-$free)/$tot)*100,1) }',
  '$isWin=($PSVersionTable.PSEdition -ne "Core")',
  '$procs=@()',
  'foreach($p in (Get-Process)){',
  '  $c=0',
  '  try{ if($isWin){ $c=[double]$p.TotalProcessorTime.TotalSeconds } else { $c=[double]$p.CPU } }catch{ $c=0 }',
  '  $m=0',
  '  try{ $m=[double]$p.WorkingSet64/1MB }catch{ $m=0 }',
  '  $procs+=[pscustomobject]@{name=[string]$p.ProcessName;cpuSec=[math]::Round($c,1);memMB=[math]::Round($m,1)}',
  '}',
  '$memTop=@($procs | Sort-Object -Property memMB -Descending | Select-Object -First 3)',
  '$cpuTop=@($procs | Sort-Object -Property cpuSec -Descending | Select-Object -First 3)',
  '$out=[ordered]@{}',
  '$out.time=((Get-Date).ToString("yyyy-MM-dd HH:mm:ss"))',
  '$out.ram=$ram',
  '$out.ramUsedMB=[math]::Round(($tot-$free)/1024,1)',
  '$out.ramTotalMB=[math]::Round($tot/1024,1)',
  // ⚡ 逻辑核数**不在这儿查**（Win32_Processor 每次 1.0~1.4 s，而 Node 的 `os.cpus().length` 立刻就有、同一个数）
  '$out.memTop=@($memTop)',
  '$out.cpuTop=@($cpuTop)',
  // ★ 先吐主 JSON（到这里为止都是快的）—— 之后再把 WMI 锚点作为**第二行 JSON**补上（可选旁证）
  '$out | ConvertTo-Json -Compress -Depth 4',
  '$wp=Get-CimInstance Win32_Processor',
  '$a=$null',
  'try{ $a=[math]::Round((($wp | Measure-Object -Property LoadPercentage -Average).Average),1) }catch{ $a=$null }',
  'if($a -ne $null){ \'{"anchor":\' + $a + \'}\' }',
].join('\n');
const PS_ASCII = /^[\x00-\x7F]*$/.test(PS);
const NODE_ASCII = /^[\x00-\x7F]*$/.test(process.execPath);
const SCRIPT_ASCII = /^[\x00-\x7F]*$/.test(new URL(import.meta.url).pathname);
if (!NODE_ASCII || !SCRIPT_ASCII || !PS_ASCII) {
  gateFail(`运行时/脚本路径含非 ASCII（脚本 ${SCRIPT_ASCII ? 'ok' : '含中文'} · node ${NODE_ASCII ? 'ok' : '含中文'} · 传参 ${PS_ASCII ? 'ok' : '含中文'}）；把工具目录挪到纯英文路径即可恢复。`);
}

// ⛔ 用 spawn + 自己收 Buffer（不是 execFileSync/encoding:'utf8' —— 那样中文进程名会按 ANSI 解成乱码）
//   ⚠ 返回的句柄带 `cancel()`，而且**杀完必须把三根流 destroy 掉**：
//     2026-10-16 23:5x 实测 —— `kill()` 只杀 powershell.exe 本身，它派生的 WMI provider 进程还攥着同一条管道，
//     管道不下线 ⇒ **Node 事件循环一直被吊着**（脚本内部 4.5 s 干完，进程却 8.1 s 才退，实测插桩确认）。
function runPs() {
  let child = null;
  let done = false;
  let resolveFn = null;
  const p = new Promise((resolve) => { resolveFn = resolve; });
  const finish = (r) => { if (!done) { done = true; resolveFn(r); } };
  const hardClose = () => {
    try { child.stdout.destroy(); } catch {}
    try { child.stderr.destroy(); } catch {}
    try { child.stdin && child.stdin.destroy(); } catch {}
  };
  try {
    child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    // ⚠ 2026-10-20 修：这里原来返回的对象**漏了 `settled`** ⇒ 下面 `psJob.settled()` 直接 TypeError
    //   （内存吃紧时 spawn 可能抛 EPERM/ENOMEM，dg-gui 就是撞在这条上："负载闸坏了 psJob.settled"）
    finish({ ok: false, err: String((e && e.message) || e) });
    return { promise: p, cancel: () => {}, unrefAll: () => {}, settled: () => true };
  }
  const out = []; const errb = [];
  child.stdout.on('data', (b) => out.push(b));
  child.stderr.on('data', (b) => errb.push(b));
  child.on('error', (e) => finish({ ok: false, err: String((e && e.message) || e) }));
  child.on('close', (code) => finish({
    ok: code === 0,
    code,
    text: Buffer.concat(out).toString('utf8'),
    err: Buffer.concat(errb).toString('utf8').split(/\r?\n/)[0] || '',
  }));
  const timer = setTimeout(() => { try { child.kill(); } catch {} hardClose(); finish({ ok: false, err: 'powershell 超时（8s）' }); }, 8000);
  const cancel = (why) => { clearTimeout(timer); try { child.kill(); } catch {} hardClose(); finish({ ok: false, err: why || '已取消' }); };
  // ★ 2026-10-16 23:5x 实测：Windows 上这两根管道句柄（Socket）**会在 powershell.exe 退出后继续吊着 Node**
  //   （插桩实测：脚本 4.5 s 就干完，进程却 8.1 s 才退，`_getActiveHandles()` 里始终是 `[Socket,Socket]`）。
  //   ⇒ 输出收完（JSON 已经 parse 过）之后显式把它们从事件循环里摘掉：先 `unref()`，再 `destroy()`。
  const unrefAll = () => {
    for (const st of [child.stdout, child.stderr]) {
      try { st.unref && st.unref(); } catch {}
      try { st.destroy(); } catch {}
    }
  };
  return { promise: p, cancel, unrefAll, settled: () => done };
}

const psJob = runPs();                       // ← 与采样并行跑（不 await）：给内存旁证 + top 进程 + WMI 锚点
const ramTotalMB = Math.round(os.totalmem() / 1048576 * 10) / 10;
const ramUsedMB = Math.round((os.totalmem() - os.freemem()) / 1048576 * 10) / 10;
const ram = Math.round((ramUsedMB / ramTotalMB) * 1000) / 10;      // 内存口径＝(总量−可用)/总量（Node 即时读，不等 PS）
const t0 = Date.now();
const samples = DEEP ? await sampleCpuDeep() : await sampleCpu();
const elMs = Date.now() - t0;
if (!samples.length) gateFail('3 次采样全失败（os.cpus() 拿不到 tick 差分）');
if (!(ram >= 0 && ram <= 100)) gateFail(`内存算不出来（total=${ramTotalMB}MB used=${ramUsedMB}MB）`);
const cpu = Math.round((samples.reduce((a, b) => a + b, 0) / samples.length) * 10) / 10;

// 采样跑完：PS 要是已经跑完就直接收，**没跑完才等**（最多 600 ms）—— `settled()` 见 runPs
let ps = psJob.settled() ? await psJob.promise : await Promise.race([psJob.promise, sleep(600).then(() => undefined)]);
if (!ps) {
  psJob.cancel('内存旁证/top 没在窗口内回来');
  const r = await Promise.race([psJob.promise, sleep(50).then(() => undefined)]);
  ps = (r && r.ok) ? r : { ok: false, err: '内存旁证/top 没在 600ms 窗口内回来（判据不受影响）' };
}
let s = null;
let anchor = null;
if (ps && ps.ok) {
  const lines = String(ps.text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const l of lines) {
    if (!l.startsWith('{')) continue;
    try {
      const j = JSON.parse(l);
      if (j.anchor != null && j.ram == null) anchor = num(j.anchor, null);   // 第二行：WMI 锚点（可选旁证）
      else if (j.ram != null) s = j;                                         // 第一行：内存 + top + 核数
    } catch (e) { /* 半截 JSON（被 kill 时）忽略 */ }
  }
}
const ramPs = s ? num(s.ram, null) : null;
psJob.unrefAll();          // ★ 输出已收完 ⇒ 把两根 PS 管道从事件循环摘掉（不来这一下，Node 会多吊 3~4 s，见 runPs 注释）

// ── 判据（唯一一处）＋ top 去重（内存前 3 + CPU 秒前 3） ─────────────────────────────────
const verdict = (cpu >= MIN_WARN || ram >= MIN_WARN) ? 'stop' : (cpu >= MIN_OK || ram >= MIN_OK) ? 'warn' : 'ok';
const EXIT = { ok: 0, warn: 10, stop: 20 };
const overWarn = [];
if (cpu >= MIN_WARN) overWarn.push(`CPU ${cpu}%`);
if (ram >= MIN_WARN) overWarn.push(`内存 ${ram}%`);
const overOk = [];
if (cpu >= MIN_OK) overOk.push('CPU');
if (ram >= MIN_OK) overOk.push('内存');
const RAM_TXT = `CPU ${cpu}% · 内存 ${ram}%`;
const VERDICT_TXT = verdict === 'stop'
  ? `⛔ 停重活（${overWarn.join('、')} ≥${MIN_WARN}%）`
  : verdict === 'warn'
    ? `⚠ 停止派单（${overOk.join('/')} ≥${MIN_OK}%，用户 2026-10-16 定）`
    : '✓ 可派单';

const seen = new Set();
const top = [];
const memTopList = [];
for (const p of [...arr(s && s.memTop), ...arr(s && s.cpuTop)]) {   // ★ 内存序在前（"谁在吃内存"就该按内存排）
  const name = String((p && p.name) || '').trim();
  if (!name || seen.has(name)) continue;
  seen.add(name);
  memTopList.push({ name, cpuSec: num(p.cpuSec, 0), memMB: num(p.memMB, 0) });
}
memTopList.sort((a, b) => b.memMB - a.memMB);
top.push(...memTopList.slice().sort((a, b) => b.cpuSec - a.cpuSec));   // 兼容老口径：top 仍按 CPU 秒排

const out = {
  time: String((s && s.time) || new Date().toLocaleString('sv-SE')),
  cpu, ram,
  samples,
  verdict,
  exit: EXIT[verdict],
  top,
  // ★ top 按 CPU 秒排（老口径不变）；`topMem` 按内存排（"谁在吃内存"看这个；与 top 同一集合去重后排序）
  topMem: memTopList,
  minOk: MIN_OK, minWarn: MIN_WARN,
  ramUsedMB, ramTotalMB,
  intervalMs: SAMPLE_INTERVAL_MS,
  cores: num(s && s.cores, os.cpus().length),
  anchor,
  anchorNote: 'cpu=os.cpus() 差分 3 次/1.5s 的均值；ram=(总−可用)/总（Node 即时读）；'
    + 'anchor=Win32_Processor.LoadPercentage 单点（口径点名的那个数，**仅旁证、不参与判据**）；'
    + 'anchorRam=PS 口径的内存%（旁证，与 ram 同量级即可）',
  anchorRam: ramPs,
  mode: DEEP ? 'deep（3 次真 WMI / 1.5s，约 7.5~9 s）' : 'normal（os.cpus() 差分 3 次 / 1.5s ≈3.0 s）',
  elapsedMs: elMs,
  warn: (!ps || !ps.ok || !s)
    ? `⚠ 内存旁证/top 没拿到（${(ps && ps.err) || (s ? '只有锚点' : '回包解析失败')}）—— cpu/ram 判据不受影响`
    : '',
};

if (has('--json')) {
  process.stdout.write(JSON.stringify(out) + '\n');
} else if (has('--quiet')) {
  process.stdout.write(`→ ${VERDICT_TXT}\n`);
} else {
  process.stdout.write(`负载闸：${RAM_TXT} → ${VERDICT_TXT}\n`);
}
if (out.warn && !has('--quiet')) process.stderr.write(out.warn + '\n');
// ⛔ 显式退出（本文件里唯一一处 `process.exit`）：理由见 runPs 那段实测注释 ——
//    Windows 上那两根 PS 管道句柄会在子进程退出后继续把 Node 吊住 ~3.5 s（`elapsedMs` 只有 4.5 s，进程却 8.1 s 才退）。
//    本工具**没有任何网络请求**（`清理请求.mjs` 那条"process.exit 会打断 undici 收尾"的坑在这里不存在），
//    而且 stdout 三行都是同步写入（管道/文件在 Windows 上是同步写）⇒ 写完再退出不会丢输出。先摘句柄再退，双保险。
try { psJob.unrefAll(); } catch {}
process.exit(EXIT[verdict]);
