// 网页版 AI 桥 · 渲染层这一半（2026-09-22 · v3.12：聊天框按几何位置选 + 正文结构法）
// ★ 本文件就是**唯一真身**（不另存副本）：改完 `node --check` 一下、点顶栏 ⟳ 即生效（beacon 见 data\webai-bridge-beacon.txt）。
// 作用：让**任何会话/脚本**（引擎侧）能问顶栏那 5 个免费网页版 AI（DeepSeek/豆包/通义/智谱/Kimi），
//       完全不花 API token。链路：
//       会话 → node scripts\webai.mjs ask <key> "问题"
//            → HTTP 127.0.0.1:31239/webai/ask（main.js 里的桥服务）
//            → broadcast('webai:task') → **本文件**接到任务（先 claim 抢到唯一处理权）
//            → 复用顶栏那套 <webview>（partition=persist:webai-<key>，登录态/预热都在那边）
//            → 往页面里输入问题 + 回车/点发送 → 轮询页面文本直到"确认它答完"
//            → 有新图/要图就把图抓成 dataURL 落到中转文件 → app.webai.done() 回传
//
// 设计取舍（都是踩过的坑，别改回去）：
//  ① **复用**顶栏窗口而不是自己建 <webview>：登录态、预热、SSO 全归那套管；窗口是**可见**的，
//     用户可以看着它干活，遇到验证码能直接接手。
//  ② 读回答只读 `document.body.innerText` 的尾部，**不依赖任何站点选择器**（各家 DOM 一月一变，
//     选择器必然烂）。找输入框用"最后一个可见的 textarea/contenteditable/input"这种通用启发式。
//  ③ 幂等：⟳ 重跑会重新注入本文件，但 `window.__kunWebAiBridge` 挂在 window 上 ⇒ 状态不丢、
//     监听不叠（preload 侧只有一个分发器，onTask 只是替换回调）。
//  ④ 一次只干一件（S.busy 串行）：同一时刻往两个网页版打字，人手也跟不上，何况浏览器。
//  ⑤ 图片走**中转文件**而不是塞进回答文本：dataURL 动辄几百 KB～几 MB，塞文本里会把"文字回答"
//     整个冲掉（桥还会截尾 8000 字）。所以图只进中转文件，回答文本里留一行标记给脚本读。
//  ⑥ **判定"答完了"必须先确认"它开始答了"**：发问后页面会长一次（出现我的气泡），随后是思考期，
//     页面一动不动 —— 早期版本就在这儿误判、8 秒就返回了空回答。见 wait 循环里的 started/firstChange。
//  ⑦ **要图要单独等**：豆包出图时先插一张同尺寸的 `data:image/svg+xml` 占位骨架，真图（blob:/https:）
//     几百毫秒到几十秒后才换上；只按"文字稳定"收工必然抓到占位图（实测抓到 138 字节的骨架）。
//     所以：占位图一律排除，要图时最多再等 60 秒等真图出现。
//  ⑧ 真图优先 `fetch` 拿原图（带登录态，签名 CDN 也行）；被 CORS 挡住时退化成对那块区域
//     `wv.capturePage()` 截屏（分辨率受窗口大小限制，是保底不是首选）。
(function () {
  'use strict';
  var S = window.__kunWebAiBridge;
  if (!S) { S = window.__kunWebAiBridge = { ver: '3.36', busy: false, last: null, lastAsset: null, log: [] }; }
  S.ver = '3.36';
  var K = window.app;
  if (!K || !K.webai) {
    console.warn('[webai-bridge] preload 里还没有 app.webai ⇒ 壳是旧的，重启一次 GUI 才生效');
    return;
  }
  // 图片中转文件（脚本侧 webai.mjs --save-image 会读它并解码成真图）
  var SPOOL_B64 = '<工作台>\\外壳\\data\\webai-last-image.b64';
  var SPOOL_JSON = '<工作台>\\外壳\\data\\webai-last-image.json';
  var MAX_B64 = 3600000;                       // 主进程 kun:file:write 上限 4MB，留余量
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var say = function (m) {
    S.log.push(Date.now() + ' ' + m);
    if (S.log.length > 60) S.log.shift();
    console.info('[webai-bridge] ' + m);
  };
  // executeJavaScript 的返回值不受我们控制（页面在导航/脚本被拦时会返回 null 或别的东西）⇒ 一律过一道
  var asImgs = function (x) { return Array.isArray(x) ? x : []; };
  // ★2026-09-26（修豆包）★ 每个站"页面一动不动多久就算它说完了"的**兜底**值。
  //   为什么必须按站给：豆包纯文字实测 **45~60s** 才吐答案，而它的思考期页面**完全不动** ——
  //   用统一的 20s 兜底会在答案还没出来时收工（实测 26s 就返回了我自己的**提问回声** / 或 0 字）。
  //   没列出来的站照旧 20s（它们本来就在 3 秒安静规则里正常收工，别动）。
  var QUIET_DEFAULT = 20000;
  var QUIET_CAP = { doubao: 75000 };
  var quietCapOf = function (k) { return QUIET_CAP[k] || QUIET_DEFAULT; };

  // ---------- 找到 / 唤起某个站的 webview ----------
  var ensureWv = async function (key, waitMs) {
    var st = window.__kunWebAi;
    var win = st && st.wins && st.wins[key];
    if (!win || !win.wv) {
      // ★2026-09-30 用户规矩（原话：「以后你以及其他场景调用免费 ai 的时候不要打开新窗口，用 gui 界面左上角的」）★
      //   以前这里会去**点顶栏那颗图标**把窗口开出来 —— 于是会话一跑活（或跑 5 站体检 probe），
      //   屏幕上就自己蹦出几个窗口，用户正在录屏时尤其恼人。
      //   现在分两种情形，只有第二种才报错：
      //     ① 窗口**本来就在**、只是 guest 被「⏏ 释放内存」或正在重载 ⇒ 点它自己的重试键把它救回来（这不叫开新窗）；
      //     ② **压根没开** ⇒ 直接失败并说清去哪点开，**绝不替用户开窗**。
      var rv = (win && win.el) ? win.el.querySelector('.webai-act[data-act="retry"]') : null;
      if (rv) { try { rv.click(); } catch (e) { } }
      else {
        // ★2026-09-30★ 静默挂载：以前这里直接抛"窗口没开，去点顶栏图标"。可用户既要"别自己弹窗"、
        //   又不想每次动手 ⇒ 改请界面**在收起状态下**把窗口/guest 建好（`__kunWebAiSilentMount` =
        //   ensure(key,'warm') + rebuildGuest，**不调 webAiShow、不 raise**）⇒ 屏幕上什么都不出现，活照跑。
        //   只有"界面没接上/没这个钩子"时才报错让人去点。
        var okS = false;
        try { okS = !!(window.__kunWebAiSilentMount && window.__kunWebAiSilentMount(key)); } catch (e) { }
        if (okS) {
          say(key + ' 的窗口没开 ⇒ 已**静默挂载**（保持收起，屏幕上不弹窗），稍等它把页面建起来');
          for (var wi = 0; wi < 24; wi++) {          // 最多等 7 秒，让它把 guest 建起来
            await sleep(300);
            win = st && st.wins && st.wins[key];
            if (win && win.wv) break;
          }
        }
        if (!win || !win.wv) {
          throw new Error('『' + key + '』的窗口没开，静默挂载也没成功 —— 请点顶栏左上角那颗图标把它打开再用'
            + '（按用户规矩：桥绝不自己弹窗）');
        }
      }
    }
    var t0 = Date.now();
    var cap = waitMs || 40000;
    var askedMount = false;      // "请界面打开窗口"只喊一次，别每 400ms 喊一遍
    while (Date.now() - t0 < cap) {
      win = st && st.wins && st.wins[key];
      var wv = win && win.wv;
      // ★2026-09-23 22:5x 修（不升版本号，见文件头说明）★
      //   坑：`getURL()` / `isLoading()` **自己就会抛** "The WebView must be attached to the DOM…"
      //   —— webview 刚被 ⟳ 重建、guest 还没 dom-ready 时必现（实测：桥 22:49:34 重载，探针 22:49:45 起跑，
      //   deepseek 在 'ensure' 步**0 秒秒失败**、报 `[ensure] The WebView must be attached…`；
      //   而同一状态下隔一会儿手动再问一次就通 ⇒ 属于"本该等一等，却被判死"）。
      //   所以这两个调用一律包 try/catch：抛了就当"还没就绪"，继续等 + 请界面把窗口挂上。
      var url = '';
      try { url = (wv && wv.getURL) ? String(wv.getURL() || '') : ''; } catch (e) { url = ''; }
      if (wv && !url && !askedMount) {
        askedMount = true;
        var okM = false;
        try {
          okM = !!(window.__kunWebAiSilentMount ? window.__kunWebAiSilentMount(key)
            : (window.__kunWebAiEnsure && window.__kunWebAiEnsure(key)));
        } catch (e) { }
        say('⚠ ' + key + ' 的页面还没就绪（刚重载/刚释放内存），已请界面**在收起状态下**把它挂好' + (okM ? '（不弹窗）' : '（界面没接上，点顶栏那个图标）'));
      }
      if (url) {
        var loading = false;
        try { loading = !!(wv.isLoading && wv.isLoading()); } catch (e) { loading = true; }
        if (loading) { await sleep(400); continue; }
        // ★v3.17：还要确认它**挂在 DOM 上**。`getURL()` 有值 ≠ 能执行脚本：
        //   未挂载时 electron 直接抛 `[ensure] The WebView must be attached to the DOM`
        //   （实测：面板被「⏏ 释放内存」过、或站点窗口还没打开时就是这个错，一问就 0 字失败）。
        //   挂载要经 renderers.js ⇒ 请它把窗口显示出来（只"显示"，不 toggle，不会关掉你正开着的窗口）。
        if (wv.isConnected === false) {
          if (!askedMount) {
            askedMount = true;
            var okMount = false;
            try {
              okMount = !!(window.__kunWebAiSilentMount ? window.__kunWebAiSilentMount(key)
                : (window.__kunWebAiEnsure && window.__kunWebAiEnsure(key)));
            } catch (e) { }
            say('⚠ ' + key + ' 的页面没挂在窗口上，已请界面**在收起状态下**重新挂上' + (okMount ? '（不弹窗）' : '（界面没接上，点顶栏那个图标）'));
          }
          await sleep(500); continue;
        }
        return wv;   // 已加载完
      }
      await sleep(300);
    }
    throw new Error('等不到 ' + key + ' 的网页版窗口加载完（点顶栏那个图标看一眼，可能要登录/过验证码）');
  };

  // 在 guest 里执行脚本，容忍"还没挂上 DOM / 正在过渡"的瞬时失败（v3.17）。
  // 为什么必须重试：那个错误是**瞬时**的（挂载完成就正常），但原来一次失败就整单作废 ⇒ 表现成"随机某个站 0 字"。
  // ★v3.22★ 再把 `GUEST_VIEW_MANAGER_CALL` / `guest view` 也算进来：**GUI 重启或 ⟳ 之后 guest 会被销毁**，
  //   而此时 `getURL()` 有值、`isConnected` 也还是 true ⇒ 上面两档判据一个都不认，于是一问就**秒失败**
  //   （实测 2026-09-26 14:15 重启 GUI 后五个站全部「进不去 XX 的页面」，看着像站点改版，其实是 guest 死了）。
  //   处理：认出这档就**请界面重建 guest**（`window.__kunWebAiEnsure` → renderers.js 的 webAiRebuildGuest）再重试
  //   —— 通道自己就恢复了，不用去点顶栏图标看窗口。
  var curKey = '';                 // 当前任务在伺候哪个站（给下面的重试兜底用）
  // ★v3.25★ guest 死了的三条自救路（今天实测：GUI 重启 / ⟳ 之后 webview 会停在
  //   "`getURL()` 有值、`isConnected` 也 true、**guest 已销毁**"的怪状态：`executeJavaScript` 抛
  //   `GUEST_VIEW_MANAGER_CALL`，`[[peek]]` 有时还能通、**一打字必挂** —— 极易误判成"站点改版/要登录"）。
  //   ① 请工作台界面重建（renderers.js 的 webAiRebuildGuest）；② 把 webview 摘下来再挂回去（重挂常常就活）；
  //   ③ 给它重赋一次 src（等于让 Electron 重建 guest）；都不行就如实说，别让人以为是登录问题。
  var recoverGuest = async function (key, wv, round) {
    var done = [];
    // ★2026-09-30★ 改走**静默挂载**：`__kunWebAiEnsure` 会 `webAiShow`（把窗口弹出来提到最前）——
    //   用户正录屏时被自己蹦出来的窗口打断就是这条引起的。静默挂载只重建 guest、窗口保持收起。
    //   旧壳没有这个钩子时才退回老行为（否则新版桥 + 旧壳会彻底救不回来）。
    try {
      if (window.__kunWebAiSilentMount && window.__kunWebAiSilentMount(key)) done.push('界面静默重建');
      else if (window.__kunWebAiEnsure && window.__kunWebAiEnsure(key)) done.push('界面重建');
    } catch (e2) { }
    if (!done.length && wv && wv.parentNode) {
      try {
        var par = wv.parentNode, nxt = wv.nextSibling;
        par.removeChild(wv); await sleep(150); par.insertBefore(wv, nxt); done.push('摘下再挂回');
      } catch (e2) { }
    }
    if (!done.length && wv) {
      try { var u = String((wv.getURL && wv.getURL()) || wv.src || ''); if (u) { wv.src = u; done.push('重赋 src'); } } catch (e2) { }
    }
    say(done.length
      ? '⚠ ' + key + ' 的页面 guest 失效 ⇒ 自救：' + done.join(' / ') + '（准备第 ' + (round + 2) + ' 次重试）'
      : '⛔ ' + key + ' 的页面 guest 失效，三条自救都没走通（这不是站点改版，是 webview 的 guest 没了）');
    return done.length > 0;
  };
  var runIn = async function (wv, src, tries) {
    var n = Math.max(1, tries || 3), last = null;
    for (var i = 0; i < n; i++) {
      try { return await wv.executeJavaScript(src, true); }
      catch (e) {
        last = e;
        var msg = String((e && e.message) || e);
        if (!/must be attached|destroyed|not attached|GUEST_VIEW_MANAGER_CALL|guest view/i.test(msg)) throw e;
        if (curKey) { try { await recoverGuest(curKey, wv, i); } catch (e2) { } }
        await sleep(900 + i * 700);
      }
    }
    throw last;
  };

  // ---------- 在页面里输入问题并提交（跑在 guest 页面里） ----------
  var askSrc = function (text) {
    return '(async function(){' +
      'var t=' + JSON.stringify(String(text)) + ';' +
      'function vis(e){if(!e)return false;var r=e.getBoundingClientRect();if(r.width<5||r.height<5)return false;' +
      'var s=getComputedStyle(e);return s.visibility!=="hidden"&&s.display!=="none"&&s.opacity!=="0";}' +
      'function pick(sel){var a=[].slice.call(document.querySelectorAll(sel)).filter(vis);return a.length?a[a.length-1]:null;}' +
      // ★ 聊天框定位（v3.12）：**按几何位置选**，不再"取 DOM 里最后一个"。
      //   实测教训：网页版页面里还有"搜索/工具/侧栏"等别的输入框，按 DOM 顺序取最后一个会打到错的框上
      //   （表现：字打得进去、页面也动了，但回答区永远是页面自带文案）。聊天框的铁律＝**视口底部 + 水平居中 + 宽度大**。
      'var vw=innerWidth,vh=innerHeight;' +
      'function mk(e,r,ph,s){return{e:e,s:s,r:r,ph:ph};}' +
      'function score(e){var r=e.getBoundingClientRect();if(r.width<60||r.height<12)return null;' +
      '  if(r.bottom<vh*0.18||r.top>vh)return null;' +
      '  var cx=r.left+r.width/2;' +
      '  var bot=Math.max(0,r.bottom)/Math.max(1,vh);' +
      '  var cen=1-Math.abs(cx-vw/2)/Math.max(1,vw/2);' +
      '  var ph=((e.getAttribute&&e.getAttribute("placeholder"))||"")+" "+((e.getAttribute&&e.getAttribute("aria-label"))||"");' +
      // 搜索框一票否决：它常被 dock 在页面底部、几何分甚至比聊天框还高（实测 1318 > 1298）⇒ 光扣分不够，直接不给分。
      // 网页版聊天框的占位符是"给 X 发送消息 / 输入你的问题"，带"搜索"的多半是站内搜索。全部候选都被否掉时才用它兜底。
      '  if(/搜索|search/i.test(ph))return null;' +
      '  var s=bot*1000+cen*400+Math.min(300,r.width/4);' +
      '  return mk(e,r,ph,s);}' +
      'var raw=[].slice.call(document.querySelectorAll(\'textarea,[contenteditable="true"],input[type="text"]\')).filter(vis);' +
      'var ranked=[],loose=[];' +
      'for(var qi=0;qi<raw.length;qi++){var sc=score(raw[qi]);if(sc)ranked.push(sc);' +
      '  else{var rl=raw[qi].getBoundingClientRect();if(rl.width>=40&&rl.height>=10)loose.push(mk(raw[qi],rl,(raw[qi].getAttribute&&raw[qi].getAttribute("placeholder"))||"",rl.top));}}' +
      // 放宽档：几何判据全没过（站点布局怪、窗口被缩得很小）时用；**绝不退回"DOM 里最后一个"**（实测那样会打到搜索框）
      'ranked.sort(function(a,b){return b.s-a.s;});' +
      'if(!ranked.length){ranked=loose.sort(function(a,b){return b.s-a.s;});}' +
      'var box=ranked.length?ranked[0].e:(pick("textarea")||pick(\'[contenteditable="true"]\')||pick(\'input[type="text"]\'));' +
      'var boxInfo=ranked.slice(0,3).map(function(x){return (x.e.tagName||"")+(x.e.isContentEditable?"[ce]":"")+" "+(x.ph||"(无占位符)")+" "+Math.round(x.r.width)+"x"+Math.round(x.r.height)+"@y"+Math.round(x.r.top)+"#"+Math.round(x.s);});' +
      'if(!box)return{ok:false,err:"页面上找不到输入框（站点改版了？先手动在那个窗口里发一条试试）",cands:(function(){try{var a=[].slice.call(document.querySelectorAll(\'textarea,[contenteditable="true"],input[type="text"]\'));' +
      'var o=[];for(var i=0;i<a.length&&o.length<4;i++){var r=a[i].getBoundingClientRect();o.push((a[i].tagName||"")+(a[i].isContentEditable?"[ce]":"")+" "+Math.round(r.width)+"x"+Math.round(r.height)+"@y"+Math.round(r.top)+" "+(vis(a[i])?"可见":"不可见"));}return o;}catch(e){return[];}})()};' +
      'var before=String((document.body&&document.body.innerText)||"");' +
      // ★v3.20★ 还要单独记下**输入框自己当时那份文本**：后面 grew() 要把输入框的增减从整页字数里减掉，
      //   否则"打字进去"本身就会让整页字数上涨 ⇒ 被当成"页面长出了内容"（⚠ 豆包就是这么空了 300 秒的）。
      'var beforeBox=String(((box.isContentEditable?(box.innerText||""):(box.value||""))||""));' +
      'var typed=false,polluted=false;' +
      'try{box.setAttribute("data-webai-box","1");}catch(e){}' +          // ★v3.21★ 给输入框打个记号：读页面文本时要把"输入框自己那份"切掉（见 readSrc）
      // ⛔ 这一行原来**行首多了一个 `+`**（v3.21 手误）：`'…' + +'try{…}'` 里的第二个 `+` 是一元运算符，
      //   把字符串转成了 **NaN** ⇒ 生成的注入脚本变成 `NaNbox.focus();` ⇒ 页面 ReferenceError: NaNbox is not defined
      //   ⇒ Electron 把它包成 `GUEST_VIEW_MANAGER_CALL` ⇒ 豆包/DeepSeek **从 v3.21 起就再也打不进字**，
      //   而 `[[peek]]` 照常（它不走这段）⇒ 我一路误判成"guest 死了 / 站点改版"。`node --check` 抓不到（语法合法）。
      'box.focus();' +
      // 打字的正确姿势（实测踩坑两轮才定下来）：
      //  ① 内容可编辑框要"先全选、再 insertText" —— 直接 insertText 是插到光标处，上次没发出去的内容会跟这次粘成一条；
      //  ② 但全选必须用 **execCommand("selectAll")**（编辑器自己认），不能用 Range.selectNodeContents ——
      //     后者会把选区落到 ProseMirror 编辑区外面，insertText 直接变空操作（实测：文字压根没进框，白等 100 秒）。
      'if(box.isContentEditable){' +
      '  try{box.focus();document.execCommand("selectAll",false,null);document.execCommand("insertText",false,t);}catch(e){}' +
      '  typed=!!(box.innerText&&box.innerText.indexOf(t.slice(0,8))>=0);' +
      '  if(!typed){' +                                                     // 兜底 1：不带全选，直接 insertText（老路子）
      '    try{box.focus();box.dispatchEvent(new InputEvent("beforeinput",{bubbles:true,cancelable:true,inputType:"insertText",data:t}));}catch(e){}' +
      '    try{document.execCommand("insertText",false,t);}catch(e){}' +
      '    typed=!!(box.innerText&&box.innerText.indexOf(t.slice(0,8))>=0);}' +
      '  if(!typed){' +                                                     // 兜底 2：直接写 textContent + 派发 input（会破坏编辑器状态，但至少能进去）
      '    try{box.textContent=t;box.dispatchEvent(new InputEvent("input",{bubbles:true,inputType:"insertText",data:t}));}catch(e){}' +
      '    typed=!!(box.innerText&&box.innerText.indexOf(t.slice(0,8))>=0);}' +
      '  if(typed)polluted=((box.innerText||"").length-t.length)>60;' +
      '}else{' +
      '  var proto=box.constructor&&box.constructor.prototype;' +
      '  var d=proto&&Object.getOwnPropertyDescriptor(proto,"value");' +
      '  if(d&&d.set){d.set.call(box,t);}else{box.value=t;}' +              // 原生 setter = 整体替换，天然覆盖旧值
      '  box.dispatchEvent(new Event("input",{bubbles:true}));' +
      '  box.dispatchEvent(new Event("change",{bubbles:true}));' +
      '  typed=true;polluted=((box.value||"").length-t.length)>60;' +
      '}' +
      // 打字失败时必须把"候选框 + 打分"带回去 —— 否则只能靠用户截图猜（实测 Kimi 就是这样卡住的）
      'var why=function(){try{var o=["选中："+(boxInfo[0]||"?")];' +
      'var a=[].slice.call(document.querySelectorAll(\'textarea,[contenteditable="true"],input[type="text"]\'));' +
      'for(var i=0;i<a.length&&o.length<5;i++){var e=a[i];if(e===box)continue;var r=e.getBoundingClientRect();' +
      'o.push("另："+(e.tagName||"")+(e.isContentEditable?"[ce]":"")+" "+Math.round(r.width)+"x"+Math.round(r.height)+"@y"+Math.round(r.top)+" "+(vis(e)?"可见":"不可见")+" "+(((e.getAttribute&&e.getAttribute("placeholder"))||"").slice(0,14)));}return o.join("；");}catch(e){return"";}};' +
      'if(!typed)return{ok:false,err:"文字没能打进输入框（编辑器改版了？先在那个窗口手动发一条试试）",cands:why()};' +
      // 发送：① 回车（多数站点）② 还留在框里 ⇒ 用**几何位置**点输入框右下角那个按钮（DeepSeek 的发送键是纯 SVG 图标，
      // 没有文字也没有 aria-label，按"发送/send"关键词找必然找不到 —— 实测"文字进了框但没发出去"就是这么来的）
      // ③ 再不行就提交它所在的 form。最后**当场验证框是否已清空**，没发出去就立刻上报，别白等满超时。
      'var sent=function(){var now=box.isContentEditable?(box.innerText||""):(box.value||"");return !(now&&now.indexOf(t.slice(0,8))>=0);};' +
      // ★grew（2026-09-23 千问/智谱修复）：发完框不清空的站（通义/智谱实测），sent() 永远假 ⇒ 页面上真的长出 ≥40 字才是硬证据。
      // ★v3.20★ 但**必须把输入框自己那份减掉**：整页 innerText 里包含输入框里的字，往里打字 = 整页涨同样多 ⇒
      //   09-23 起 grew() 一直在"打字"这一步就返回 true（实测豆包：把 302 字的指令打进去 ⇒ grew 立刻真 ⇒
      //   下面 `if(!sent()&&!grew())tryBtn()` **一次都没去点发送键** ⇒ 那条指令到 09-26 还躺在框里没发出去、
      //   任务白等满 300 秒）。现在两侧都扣掉输入框的文本（前的 beforeBox、现在的 bx），只有"框外面真的长了字"才算发出去。
      // ★2026-09-30★ grew 还要**要求"我的问话真的出现在框外面"**：原来只看"整页长了 ≥40 字"，
      //   而"点错一个工具键把面板打开"也会长几百字 ⇒ 被判成"发出去了"（通义当天就这么假成功过：
      //   问题还躺在框里、返回的却是 PPT 模板墙）。问话发出去一定会在消息区回显 ⇒ 拿它当硬证据。
      'var grew=function(){try{var now=String((document.body&&document.body.innerText)||"");' +
      'var bx=String(((box.isContentEditable?(box.innerText||""):(box.value||""))||""));' +
      'if((now.length-bx.length)-Math.max(0,before.length-beforeBox.length)<40)return false;' +
      'var outside=bx?now.split(bx).join(""):now;' +
      'var q=String(t||"").slice(0,10);' +
      'return !q||outside.indexOf(q)>=0;}catch(e){return false;}};' +
      'var kd=function(ty){box.dispatchEvent(new KeyboardEvent(ty,{bubbles:true,cancelable:true,key:"Enter",code:"Enter",keyCode:13,which:13}));};' +
      // ★2026-09-30★ 点一下要"像人"：有些站点的按钮只认 pointerdown/mousedown 那一串（只派 click 会被它的
      //   手势判据丢掉）⇒ 统一走 clickHard：pointerdown → mousedown → pointerup → mouseup → click（中心点坐标）。
      'var clickHard=function(e){try{var r=e.getBoundingClientRect();var o={bubbles:true,cancelable:true,composed:true,' +
      'clientX:Math.round(r.left+r.width/2),clientY:Math.round(r.top+r.height/2),button:0};var P=window.PointerEvent,M=window.MouseEvent;' +
      'if(P){e.dispatchEvent(new P("pointerdown",o));}e.dispatchEvent(new M("mousedown",o));' +
      'if(P){e.dispatchEvent(new P("pointerup",o));}e.dispatchEvent(new M("mouseup",o));e.dispatchEvent(new M("click",o));' +
      '}catch(x){try{e.click();}catch(y){}}};' +
      'var tryBtn=function(){' +
      '  if(sent())return true;' +
      '  var br=box.getBoundingClientRect();var cands=[];' +
      // ★2026-09-30★ **不再"几何撒网"点键**。当天通义实测的教训：输入框右端那一排工具键里有「AI生图」「代码」
      //   （`BUTTON|AI生图|78x32`、`BUTTON|代码|64x32`，位置就在发送键左边一点点）⇒ 按坐标撒网点下去，
      //   **站点真会弹出「千问创作」新窗口**（用户当天投诉"你每次都会打开一堆这个窗口"就是这么来的），
      //   而且点开面板还会让整页字数暴涨、被 grew 误判成"发出去了"。
      //   现在的铁律：**只点"名字里明说是发送"的键**（aria-label/title/文字含 发送|提交|send|submit）。
      //   名字找不到发送键 ⇒ **一个字都不点**，直接交回宿主走真键盘通道（宿主会给真输入 + 真回车）。
      '  var all=[].slice.call(document.querySelectorAll("button,[role=button],a,[class*=send],[class*=submit]"));' +
      '  for(var i=0;i<all.length;i++){var e=all[i];' +
      '    if(e===box||box.contains(e))continue;' +
      '    var r=e.getBoundingClientRect();' +
      '    if(r.width<8||r.height<8||r.width>280||r.height>280)continue;' +
      '    var st=getComputedStyle(e);if(st.visibility==="hidden"||st.display==="none")continue;' +
      '    var cx=r.left+r.width/2,cy=r.top+r.height/2;' +
      '    if(cx<br.left+br.width*0.35||cy<br.top-80||cy>br.bottom+520)continue;' +      // 只认输入框那一行往右、往下这一片
      '    var nm=((e.getAttribute("aria-label")||"")+" "+(e.getAttribute("title")||"")+" "+(e.textContent||"")+" "+String(e.className||""));' +
      '    if(!/send|发送|提交|submit/i.test(nm))continue;' +                            // ← 铁律：没明说"发送"的键一律不点
      '    cands.push({e:e,d:Math.abs(cx-br.right)+Math.abs(cy-br.bottom)});}' +
      '  cands.sort(function(a,b){return a.d-b.d;});' +
      '  for(var j=0;j<cands.length&&j<3;j++){try{clickHard(cands[j].e);}catch(e){}if(sent()||grew())return true;}' +
      // 唯一保留的"看图点键"：**只认无文字的图标键**（发送键常是纯图标、没有 aria），且它在框右端那一小块、
      // 且鼠标形态不是 not-allowed（禁用态）。有文字的键（AI生图/代码/更多/千问创作…）**绝不碰**。
      '  var pts2=[[br.right-22,br.top+br.height*0.6],[br.right-22,br.bottom+18]];' +
      '  for(var p2=0;p2<pts2.length;p2++){try{var el2=document.elementFromPoint(pts2[p2][0],pts2[p2][1]);' +
      'var cl2=(el2&&el2.closest)?(el2.closest("button,[role=button]")||el2):el2;' +
      'if(!cl2||cl2===box||box.contains(cl2))continue;' +
      'if(String(cl2.textContent||"").trim())continue;' +
      'if(getComputedStyle(cl2).cursor==="not-allowed")continue;' +
      'clickHard(cl2);if(sent()||grew())return true;}catch(e){}}' +
      '  var fm=box.closest&&box.closest("form");' +
      '  if(fm&&!sent()){try{if(fm.requestSubmit)fm.requestSubmit();else fm.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}));}catch(e){}}' +
      '  return sent();};' +
      'var kdc=function(){box.dispatchEvent(new KeyboardEvent("keydown",{bubbles:true,cancelable:true,key:"Enter",code:"Enter",keyCode:13,which:13,ctrlKey:true}));};' +
      'var sl=function(ms){return new Promise(function(r){setTimeout(r,ms)});};' +
      // ★2026-09-30★ 打字之后先问一句"发送键现在是可用还是禁用"——**站点有没有认下我打的字，全看这个**。
      //   通义实测：字显示在框里、键却一直 `disabled / cursor:not-allowed`（内部状态为空）⇒ 这时合成回车、
      //   点键都是白费（还可能点到工具键弹窗），所以**禁用态时一次都不点**，直接把 stNow 带回宿主走真键盘通道。
      'var stNow=(function(){try{var a=document.querySelectorAll("button,[role=button],[class*=send],[class*=submit]");' +
      'for(var i=0;i<a.length;i++){var n=((a[i].getAttribute("aria-label")||"")+" "+(a[i].className||"")+" "+(a[i].textContent||""));' +
      'if(!/send|发送|提交/i.test(n))continue;return (a[i].disabled||(a[i].getAttribute&&a[i].getAttribute("aria-disabled")==="true"))?"禁用":"可用";}return "没找到";}catch(e){return "?";}})();' +
      'kd("keydown");kd("keypress");kd("keyup");' +
      // ★2026-09-30★ 效率：不再无条件走 2.5 秒固定节拍 ——
      //   ① 合成回车**当场就成了**（`sent()` / `grew()` 为真）⇒ 立刻返回，省 ~2.2 秒（deepseek/豆包/智谱都吃这条）；
      //   ② `sendState==='禁用'`（站点没认下注入的字）⇒ 补按 / 补点**必然无效**，等 0.2 秒确认就走人，
      //      把时间让给宿主的真键盘通道（通义整单实测因此再省 ~2 秒）。
      'await sl(350);' +
      'if(!sent()&&!grew()){' +
      '  if(stNow!=="禁用"){' +
      '    await sl(350); if(!sent()&&!grew())tryBtn();' +
      '    await sl(900); if(!sent()&&!grew())tryBtn();' +
      '    await sl(400); if(!sent()&&!grew())kdc();' +
      '    await sl(500);' +
      '  } else { await sl(200); }' +
      '}' +
      'return{ok:true,sent:sent()||grew(),polluted:polluted,where:(box.tagName||"")+(box.isContentEditable?"[ce]":""),' +
      // ★nowLen（v3.17）：发送尝试之后的**当前整页字数**，配合 len（发问前字数）就能判断"页面是不是真长出了东西"。
      // 为什么需要它：`sent()` 用的判据是"输入框变空了"，而**通义/智谱发出去之后框里仍然留着问话** ⇒ 被判成没发出去，
      //   于是桥一路补按、最后抛错（实测 2026-09-23：通义 8s 就报"问话没能发出去"，其实它可能已经发出去了）。
      //   页面有没有长字才是硬证据：长出 ≥60 字 ⇒ 一定发出去并且开始答了。
      'pageLen:(function(){try{return String((document.body&&document.body.innerText)||"").length;}catch(e){return -1;}})(),' +
      // ★2026-09-30★ 发送键当时是"可用"还是"禁用"：**这就是"站点有没有认下我打的字"的判据**。
      //   通义实测：注入的字显示在框里，但发送键一直是 `disabled / cursor:not-allowed`（站点内部状态为空）
      //   ⇒ 宿主一看是"禁用"就直接跳去真键盘通道，不再浪费 6 秒试合成回车/点击。
      'sendState:stNow,boxInfo:boxInfo,nBox:ranked.length,len:before.length,before:before.slice(-6000),' +
      // 发不出去时把"输入框右下方附近的元素"原样带回去（tag.class|aria-label|尺寸@相对坐标|disabled）——
      // 这样下一轮不用猜发送键长什么样（实测通义就是靠这个才看清：它的输入区带"AI生图/参考图/比例"模式切换）
      // ★2026-09-30★ 现场清单要能看见**发送键**：以前只收"框左下 ±400px 内 DOM 顺序前 10 个"，
      //   通义这种"框下方一长排工具键（＋/快速/工作助理/PPT创作/更多）＋ 发送键在最右端"的站，
      //   发送键**永远被前 10 个工具键挤掉** ⇒ 报错里看不到它、也没法一眼分清"没找到键"还是"键是禁用态"。
      //   现在：① 每个候选上溯到可点容器（button/[role=button]/a），排除 svg/path 叶子；
      //        ② 框那一行的**右半段**优先，再补框下方；③ 带 `|DISABLED` 标记；④ 再用 elementFromPoint 在
      //        "框右下角"探三针（发送键常是无文字无 aria 的图标键，DOM 顺序排得很后，只有探针能找到它）。
      'btns:(function(){try{var br=box.getBoundingClientRect();var out=[];' +
      'var push=function(e,tag){if(!e||e===box||box.contains(e))return;var r=e.getBoundingClientRect();' +
      'if(r.width<8||r.height<8)return;var st=getComputedStyle(e);if(st.display==="none"||st.visibility==="hidden")return;' +
      'var s=(e.tagName||"")+"."+String(e.className||"").slice(0,34)+"|"+((e.getAttribute&&(e.getAttribute("aria-label")||e.getAttribute("title")))||"")+"|"+' +
      'Math.round(r.width)+"x"+Math.round(r.height)+"@("+Math.round(r.left-br.left)+","+Math.round(r.top-br.top)+")"+(tag?"|"+tag:"")' +
      '+((e.disabled||(e.getAttribute&&e.getAttribute("aria-disabled")==="true"))?"|DISABLED":"");' +
      'if(out.indexOf(s)<0)out.push(s);};' +
      'var up=function(e){return (e&&e.closest&&(e.closest("button,[role=button],a")||e))||e;};' +
      'var all=[].slice.call(document.querySelectorAll("button,[role=button],a,[class*=send],[class*=submit]"));' +
      'for(var i=0;i<all.length&&out.length<10;i++){var e=up(all[i]);var r=e.getBoundingClientRect();' +
      'if(r.width<8||r.height<8)continue;' +
      'if(!(r.top<br.bottom+140&&r.bottom>br.top-60&&r.left>br.left+br.width*0.35))continue;' +   // 框那一行的右半段
      'push(e,"行");}' +
      'for(var i2=0;i2<all.length&&out.length<14;i2++){var e2=up(all[i2]);var r2=e2.getBoundingClientRect();' +
      'if(r2.width<8||r2.height<8)continue;' +
      'if(r2.left<br.left-60||r2.top<br.top-60||r2.left>br.right+400||r2.top>br.bottom+300)continue;' +
      'push(e2,"下");}' +
      'var pts=[[br.right-24,br.top+br.height/2],[br.right-24,br.bottom+16],[br.right-56,br.bottom+20]];' +
      'for(var p=0;p<pts.length;p++){try{var el=document.elementFromPoint(pts[p][0],pts[p][1]);if(el)push(up(el),"pt"+p);}catch(e){}}' +
      'return out;}catch(e){return[];}})(),' +
      'imgs:[].slice.call(document.querySelectorAll("img")).map(function(im){return im.currentSrc||im.src||"";}).filter(Boolean).slice(-20)};' +
      '})()';
  };

  // ---- 正文提取 A（首选，v3.12）：**结构定位** —— 找"消息容器"，取它最后一个 != 问话回声的块。
  // 为什么不用老的"整页尾部按关键词切"：那种切法在 5 个站上全靠尾部工具条和回声位置，
  // 实测会切出侧栏/面板文案（智谱返回了"AI画图/精选工具"）或 0 字（DeepSeek）——2026-09-22 真机联调两连败。
  var BLOCKS_SRC = '(function(t,box,cut){' +
    'var T=String(t||"");var CUT=cut||null;' +
    'var cutTop=CUT?-1:null,cutEl=null;' +
    'if(CUT&&CUT.anchor){' +
    '  var na=document.querySelectorAll("div,p,span,li,textarea,[contenteditable=true]");' +
    '  for(var ci=na.length-1;ci>=0;ci--){var ce=na[ci];if(!vis(ce))continue;' +
    '    var ct=blkText(ce).replace(/\\s+/g," ").trim();if(ct.length<6)continue;' +
    '    if(ct.indexOf(CUT.anchor)>=0){cutEl=ce;cutTop=ce.getBoundingClientRect().top;break;}}' +
    '}' +
    'function vis(e){if(!e)return false;var r=e.getBoundingClientRect();if(r.width<40||r.height<8)return false;' +
    'var s=getComputedStyle(e);return s.visibility!=="hidden"&&s.display!=="none"&&s.opacity!=="0";}' +
    'function inBox(e){return !!(box&&e&&(e===box||box.contains(e)));}' +
    'function overscroll(el){var t=0,tv=el&&el.scrollHeight?(el.scrollHeight-el.clientHeight):0;' +
    '  if(tv>60)t+=tv>240?600:160;' +
    '  if(el&&el.getAttribute){var st=getComputedStyle(el);if(st.overflowY==="auto"||st.overflowY==="scroll")t+=140;}' +
    '  return t;}' +
    'function blkText(e){var s="";try{s=String(e.innerText||"");}catch(x){s="";}return s;}' +
    // 分界线（v3.16）：cut = "发问前那份页面文本"和"现在的页面文本"的公共前缀长度。
    //   为什么非要它：DeepSeek 把**最新一条消息渲染在最上面** —— 光看块数/宽度/文档顺序都分不出新旧，
    //   实测会稳定回上一次对话的内容（问"收到收到"，答的是上一次的汽车尺寸）。
    //   页面比发问时长出来的那一段，就是这次的问题+回答 ⇒ 落在 cut 之后的块才可能是这次的回答。
    'function afterCut(e,cutEl,cutTop){if(!cutTop&&cutTop!==0)return true;if(!e||!e.getBoundingClientRect)return true;' +
    '  if(cutEl&&(e===cutEl||cutEl.contains(e)||e.contains(cutEl)))return false;' +
    '  return e.getBoundingClientRect().top>=cutTop-2;}' +
    // 侧栏/历史列表识别（v3.13）：那种容器里全是 2~10 字、不带标点的短标题（"自我复盘/学英语/炒股…"）。
    // 实测豆包就是用这种容器骗过了"块数最多"的排序，回了一整屏历史标题 ⇒ 先把它判掉。
    'function menuish(el){var ch=el.children,seen=0,short=0,nop=0;' +
    '  for(var i=0;i<ch.length;i++){var t=blkText(ch[i]).trim();if(!t)continue;seen++;' +
    '    if(t.length<=12){short++;if(!/[,，。！？：:；;、,.!?]/.test(t))nop++;}}' +
    '  return seen>=5&&short/seen>=0.7&&nop/seen>=0.5;}' +
    // 菜单墙识别（v3.14）：豆包侧栏是 `新工作任务 Ctrl J\n新对话 Ctrl Shift K\n…` —— 一个块里好几行**带快捷键的短标题**，
    // 按总字符数看每块都有 12~40 字，上面那条判据抓不住。这里按**平均行长**算：菜单每行都很短（实测 13~16 字），
    // 正文/代码被换行切碎后平均行长仍 >16。用平均而不是逐行阈值，是为了不误杀"代码里很短的几行"。
    'function lookMenu(t){var s=String(t||"");' +
    '  if(s.length<40||/[,，。！？；;]/.test(s))return false;' +
    '  var ls=s.split("\\n"),n=0,sum=0;for(var i=0;i<ls.length;i++){var x=ls[i].trim();if(!x)continue;n++;sum+=x.length;}' +
    '  return n>=5&&sum/n<=16;}' +
    'var all=[].slice.call(document.querySelectorAll("div,section,article,main,ul,ol"));' +
    'var cands=[];' +
    'for(var i=0;i<all.length;i++){var el=all[i];' +
    '  if(inBox(el)||!vis(el))continue;' +
    '  var rw=el.getBoundingClientRect().width;if(rw<320)continue;' +
    '  var ch=el.children;if(!ch||ch.length<2)continue;' +
    '  if(menuish(el))continue;' +
    // v3.16 放宽：原来要求直接子元素里 ≥2 个长文本块。可短回答（"北京""14:30"）+ 精简操作条的行
    //   两个条件都不满足 ⇒ 整个页面一个候选都没有，只能退化成整页尾切（Kimi 打不进字、通义回侧栏就发生在这一步）。
    //   下一条兜底：直接子元素里只要有 1 个长文本块就也算候选。次序更差，所以要排在严格候选之后。
    '  var cn=0;for(var j=0;j<ch.length;j++){var s2=blkText(ch[j]);if(s2.replace(/\\s+/g,"").length>24)cn++;}' +
    '  if(cn>=2){var last=null;for(var k=ch.length-1;k>=0;k--){if(blkText(ch[k]).replace(/\\s+/g,"").length>4){last=ch[k];break;}}' +
    '    if(last&&inBox(last))continue;' +
    '    cands.push({el:el,n:cn,sc:overscroll(el),w:rw,txt:blkText(el),relax:0});continue;}' +
    '  if(cn===1){var one=null;for(var k2=ch.length-1;k2>=0;k2--){if(blkText(ch[k2]).replace(/\\s+/g,"").length>24){one=ch[k2];break;}}' +
    '    if(one&&inBox(one))continue;' +
    '    cands.push({el:el,n:0,sc:overscroll(el),w:rw,txt:blkText(el),relax:1});}' +
    '}' +
    // 先按块数，再按宽度（侧栏窄、对话区宽），再按可滚动性 —— 宽度是这次新加的关键判据
    'cands.sort(function(a,b){return (b.n-a.n)||(b.w-a.w)||(b.sc-a.sc)||(b.txt.length-a.txt.length);});' +
    'var win=cands.slice(0,3);' +
    // 深挖：在最优候选内部再往下找 2~4 层，消息列表往往不是最外层
    'for(var w=0;w<win.length;w++){var cur=win[w].el;' +
    '  for(var dep=0;dep<3;dep++){var best=null;var kids=cur.children||[];' +
    '    for(var q=0;q<kids.length;q++){var k2=kids[q];if(inBox(k2)||!vis(k2))continue;var cc=k2.children||[];var cn=0;' +
    '      for(var z=0;z<cc.length;z++){if(blkText(cc[z]).replace(/\\s+/g,"").length>24)cn++;}' +
    '      if(cn>=2&&(!best||cn>best.cn))best={node:k2,cn:cn};}' +
    '    if(best)cur=best.node;else break;}' +
    '  win[w].el=cur;win[w].txt=blkText(cur);}' +
    'function readEl(el){var out=[];var kids=el.children||[];' +
    '  for(var i=0;i<kids.length;i++){var e=kids[i];if(inBox(e))continue;' +
    '    var r=null;try{r=e.getBoundingClientRect();}catch(x){r=null;}' +
    '    out.push({text:blkText(e).replace(/\\s+$/,""),top:r?r.top:null,el:e,idx0:i});}' +
    '  return out;}' +
    // 有分界线时：只认**新长出来**的块；并且按视觉位置排序（DeepSeek 最新消息在最上面 ⇒ 文档顺序是反的，位置才是真的）
    'function marked(el){return cutTop===null?true:afterCut(el,cutEl,cutTop);}' +
    'function pick(blocks){' +
    '  for(var i=blocks.length-1;i>=0;i--){var s=blocks[i].text;var z=s.replace(/\\s+/g,"");' +
    '    if(z.length<4)continue;' +
    '    if(T&&s.indexOf(T.slice(0,24))>=0&&z.length<=Math.max(80,T.replace(/\\s+/g,"").length*3))continue;' +
    // 问话回声判据：块文本是问话的子串 ⇒ 是回声。但**只有它本身就跟问话差不多长**才算（≥80%）——
    // 否则短回答会被误杀：问"只回复四个字：收到收到"、答"收到收到"（占问话 50%），实测就是被这条丢掉的。
    // 判错方向：宁可漏掉一次回声，也不能把真回答扔掉。
    '    if(T&&z.length>=Math.max(4,Math.round(T.replace(/\\s+/g,"").length*0.8))&&T.indexOf(z.slice(0,12))>=0&&z.length<=T.length+6)continue;' +
    '    if(z.length>6000)continue;' +
    '    return {text:s.replace(/^\\s+/,""),i:i,total:blocks.length,idx0:blocks[i].idx0};}' +
    '  return null;}' +
    'for(var c=0;c<win.length;c++){var b=readEl(win[c].el);' +
    '  for(var m=0;m<b.length;m++){b[m].new=marked(b[m].el);}' +
    // 没分界线时**保持文档顺序不动**（老行为）；有分界线时才把新块提前、并按视觉位置从新到旧排
    '  var order=cutTop===null?b.slice():b.slice().sort(function(x,y){return (y.new?1:0)-(x.new?1:0)||((y.top||0)-(x.top||0));});' +
    '  var candsN=order.filter(function(x){return x.new;});' +
    '  var use=candsN.length?candsN:order;' +
    '  var got=pick(use);' +
    '  if(got)return{ok:true,text:got.text,method:"blocks",blocks:b.length,idx:(got.idx0===undefined?got.i:got.idx0),cand:c,n:win[c].n,nb:candsN.length};}' +
    'return{ok:false,method:"blocks",cands:cands.slice(0,3).map(function(x){return x.n+"块/"+x.txt.length+"字";})};' +
    '})(';

  // ---------- 只读页面文本（同样不靠选择器） ----------
  // ★2026-09-26（打通豆包 · v3.19）★ 只读 `document.body.innerText` 会**漏掉 shadow DOM 里的正文**：
  //   读图那段早就得"穿 shadow DOM"（豆包的骨架图就是证据），读文本却一直只看浅 DOM ⇒
  //   实测症状 = 页面"一个字都不长"、白等满 300 秒、抓回来只剩侧栏那几行（「豆包 / 新工作任务 / Ctrl J」）。
  //   现在：浅 DOM(innerText，只算可见) + **每个 shadow root 的文本** + **同源 iframe 的文本** 拼成一份"整页文本"；
  //   `text` 与 `len` 用同一份 ⇒ wait 循环里 core/长度差的口径不变（对别的站：没有 shadow 就等于没变）。
  var readSrc = '(function(){'
    + 'function stext(s){var out=[];(function w(n){if(!n)return;'          // shadow root 没有 innerText ⇒ 手动遍历文本节点（⚠ 别用 cloneNode+textContent，实测拿不到）
    + 'if(n.nodeType===3){var v=n.nodeValue;if(v&&/\\S/.test(v))out.push(v);return;}'
    + 'if(n.nodeType!==1&&n.nodeType!==11)return;'
    + 'if(n.nodeType===1){var tn=n.tagName;if(tn==="STYLE"||tn==="SCRIPT"||tn==="NOSCRIPT"||tn==="TEMPLATE")return;'
    + '  if(n.hasAttribute&&(n.hasAttribute("hidden")||n.getAttribute("aria-hidden")==="true"))return;'
    + '  var st=n.getAttribute&&n.getAttribute("style");if(st&&/display\\s*:\\s*none/i.test(st))return;}'
    + 'var ch=n.childNodes||[];for(var i=0;i<ch.length;i++)w(ch[i]);})(s);'
    + 'return out.join(" ").replace(/\\s+/g," ").trim();}'
    + 'var parts=[];'
    + 'function walk(doc,d){if(!doc||d>7)return;'
    + '  try{if(doc.body){var t=doc.body.innerText;if(t)parts.push(t);}}catch(e){}'   // 浅 DOM / 同源 iframe：innerText 只算可见
    + '  var all=[];try{all=[].slice.call(doc.querySelectorAll("*"));}catch(e){}'
    + '  for(var i=0;i<all.length;i++){var sr=all[i].shadowRoot;if(!sr)continue;'
    + '    var st=stext(sr);if(st)parts.push(st);walk(sr,d+1);}'
    + '  var fr=[];try{fr=[].slice.call(doc.querySelectorAll("iframe"));}catch(e){}'
    + '  for(var j=0;j<fr.length;j++){try{if(fr[j].contentDocument)walk(fr[j].contentDocument,d+1);}catch(e){}}}'
    + 'walk(document,0);var a=parts.join("\\n");'
    // ★v3.21★ 把**输入框自己那份文本**从"整页文本"里切掉（同一个坑的第三处）：输入框在页面最底下，
    //   它的提示语（豆包：「在此处拖放文件文件数量：最多 50 个, 文件类型：pdf…」176 字）会被当成"页尾正文"抓回去
    //   —— 实测 2026-09-26 14:03 豆包明明答了「已生成竖版 3:4 封面图…」，桥交回来的却是这段提示；
    //   而且**框清空时提示会重新出现 = 整页字数上涨** ⇒ 又被 grew()/完成判据当成"页面长出了内容"。
    //   记号是打字那一步打的（`data-webai-box`）；豆包这类站没有 shadow DOM，`document.body.innerText` 天然包含输入框。
    + 'try{var bx0=document.querySelector("[data-webai-box]");if(bx0){'
    + 'var bt0=String(((bx0.isContentEditable?(bx0.innerText||""):(bx0.value||""))||""));'
    + 'if(bt0&&bt0.length>1){var ii0=a.lastIndexOf(bt0);if(ii0>=0)a=a.slice(0,ii0)+a.slice(ii0+bt0.length);}}}catch(e){}'
    + 'var busy=/停止生成|停止回答|正在生成|正在思考|生成中|Stop generating|Generating/i.test(a);'
    + 'var bs=[].slice.call(document.querySelectorAll("button,[role=button]"));'
    + 'for(var k=0;k<bs.length;k++){var r=bs[k].getBoundingClientRect();if(r.width<5||r.height<5)continue;'
    + 'var tx=(bs[k].textContent||"")+" "+(bs[k].getAttribute("aria-label")||"");'
    + 'if(/停止|Stop/i.test(tx)){busy=true;break;}}'
    + 'return{text:a.slice(-40000),busy:busy,len:a.length,parts:parts.length};})()';

  // ★v3.19★ 「只看不派」的探针（`[[peek]]`）：页面到底有什么 —— 浅 DOM / shadow DOM / iframe 各多少字、
  //   输入框里有没有残留、候选框是哪个。用途：再出现"页面一个字都不长"时一眼定位，不用靠截图猜。
  var peekSrc = '(function(){var o={};try{'
    + 'o.url=String(location.href||"");'   // ★v3.35★ 当前地址：豆包「一个视频一个会话」要把它记下来，回头靠 [[goto:url=…]] 精确取回
    + 'var b=(document.body?document.body.innerText:"");o.light=b.length;o.lightTail=b.slice(-400).replace(/\\s+/g," ");'
    + 'var all=[].slice.call(document.querySelectorAll("*"));var sh=[];'
    + 'for(var i=0;i<all.length;i++){if(!all[i].shadowRoot)continue;var sr=all[i].shadowRoot;var t="";'
    + 'try{t=String(sr.textContent||"").replace(/\\s+/g," ").trim();}catch(e){}'
    + 'sh.push((all[i].tagName||"?").toLowerCase()+":"+t+"");}'
    + 'o.shadowCount=sh.length;o.shadows=sh.slice(0,5).map(function(x){return x.slice(0,220);});'
    + 'var fr=[].slice.call(document.querySelectorAll("iframe"));o.iframes=fr.slice(0,4).map(function(f){try{return (f.contentDocument&&f.contentDocument.body)?String(f.contentDocument.body.innerText||"").length:-1;}catch(e){return "X";}});'
    + 'var bs=[].slice.call(document.querySelectorAll(\'textarea,[contenteditable="true"],input[type="text"]\'));'
    + 'o.boxes=bs.slice(0,5).map(function(e){var r=e.getBoundingClientRect();var v=e.isContentEditable?(e.innerText||""):(e.value||"");'
    + 'return (e.tagName||"")+(e.isContentEditable?"[ce]":"")+" "+Math.round(r.width)+"x"+Math.round(r.height)+"@y"+Math.round(r.top)+" "+(v?String(v).length+"字:"+String(v).slice(0,60):"空");});'
    // ★2026-09-30★ 「发送键到底长什么样、是不是禁用态」——这是"问话发不出去"的唯一现场证据。
    //   起因：通义（qianwen.com）输入框能打进字、发送键却点不动，而老 peek 只报输入框、报不到发送键
    //   ⇒ 只能靠用户截图猜（当天就是这么卡住的）。现在把**输入框右端那一小块**里的可点元素全报出来：
    //   tag.class | aria/title/type | 尺寸@相对坐标 | pointer-events | opacity | cursor | DISABLED，
    //   外加 5 个 elementFromPoint 探针（直接问"框右端/右下角这几个点是哪个元素"）。
    + 'var bx=null,bxr=null,bestA=0;for(var bi=0;bi<bs.length;bi++){var rr0=bs[bi].getBoundingClientRect();if(rr0.width<40||rr0.height<8)continue;var aa0=rr0.width*rr0.height;if(aa0>bestA){bestA=aa0;bx=bs[bi];bxr=rr0;}}'
    + 'o.nearBox=(function(){try{if(!bx)return[];var out=[];var br=bxr;'
    + 'var push=function(e,tag){if(!e||e===bx||bx.contains(e))return;var r=e.getBoundingClientRect();if(r.width<6||r.height<6)return;'
    + 'var st=getComputedStyle(e);'
    + 'var s=(e.tagName||"")+"."+String(e.className||"").slice(0,30)+"|"+((e.getAttribute&&(e.getAttribute("aria-label")||e.getAttribute("title")||e.getAttribute("type")))||"")+"|"'
    + '+Math.round(r.width)+"x"+Math.round(r.height)+"@("+Math.round(r.left-br.left)+","+Math.round(r.top-br.top)+")|pe:"+st.pointerEvents+"|op:"+st.opacity+"|cur:"+st.cursor'
    + '+((e.disabled||(e.getAttribute&&e.getAttribute("aria-disabled")==="true"))?"|DISABLED":"")+(tag?"|"+tag:"");'
    + 'if(out.indexOf(s)<0)out.push(s);};'
    + 'var up=function(e){return (e&&e.closest&&(e.closest("button,[role=button],a")||e))||e;};'
    + 'var cand=document.querySelectorAll("button,[role=button],a,[class*=send],[class*=submit],svg,[class*=btn]");'
    + 'for(var i=0;i<cand.length&&out.length<10;i++){var e=up(cand[i]);var r=e.getBoundingClientRect();'
    + 'if(r.width<6||r.height<6)continue;var cx=r.left+r.width/2,cy=r.top+r.height/2;'
    + 'if(cx<br.right-160||cx>br.right+80||cy<br.top-40||cy>br.bottom+90)continue;push(e,"近");}'
    + 'var pts=[[br.right-10,br.top+br.height*0.5],[br.right-22,br.bottom+16],[br.right-22,br.bottom+36],[br.right-50,br.bottom+16],[br.right+20,br.bottom+16]];'
    + 'for(var p=0;p<pts.length;p++){try{var el=document.elementFromPoint(pts[p][0],pts[p][1]);if(el)push(up(el),"pt"+p);}catch(e){}}'
    + 'return out;}catch(e){return["ERR:"+((e&&e.message)||e)];}})();'
    // ★v3.21★ 顺带把页面上的图也报出来（tag/尺寸/src 前 90 字）—— 生图站"图生成了但截不到"时，靠这条看它到底是什么形态（img/canvas/背景图）
    + 'var ims=[].slice.call(document.querySelectorAll("img,canvas,video"));'
    + 'o.imgs=ims.slice(0,8).map(function(e){var r=e.getBoundingClientRect();'
    + 'var src=e.tagName==="IMG"?String(e.currentSrc||e.src||""):(e.tagName==="VIDEO"?String(e.currentSrc||e.src||""):("canvas "+e.width+"x"+e.height));'
    + 'return e.tagName+" "+Math.round(r.width)+"x"+Math.round(r.height)+"@"+Math.round(r.top)+" "+src.slice(0,120);});'
    // ★v3.33★ 视频单独报（2026-09-27 实测：豆包"你的视频生成好了"但 peek 只列 img/canvas ⇒ 根本看不到视频、更拿不到地址）：
    //   报 src/尺寸/时长/poster，外加页面上的下载类链接 —— 拿到 https 地址就能用 Invoke-WebRequest 自己下（不受 3.5MB 中转上限约束）。
    + 'var V=[];function walkV(root,d){if(!root||d>4)return;try{'
    + 'var l=root.querySelectorAll?root.querySelectorAll("video"):[];'
    + 'for(var i=0;i<l.length;i++){var e=l[i];var r=e.getBoundingClientRect();var s=String(e.currentSrc||e.src||"");'
    + 'var so=e.querySelector?e.querySelector("source"):null;if(!s&&so)s=String(so.getAttribute("src")||"");'
    + 'V.push({src:s.slice(0,1600),w:e.videoWidth||0,h:e.videoHeight||0,dur:Math.round((e.duration||0)*10)/10,box:Math.round(r.width)+"x"+Math.round(r.height)});}'
    + 'var fr=root.querySelectorAll?root.querySelectorAll("iframe"):[];'
    + 'for(var k=0;k<fr.length;k++){try{if(fr[k].contentDocument)walkV(fr[k].contentDocument,d+1);}catch(e){}}'
    + 'var al=root.querySelectorAll?root.querySelectorAll("*"):[];'
    + 'for(var j=0;j<al.length;j++){if(al[j].shadowRoot)walkV(al[j].shadowRoot,d+1);}'
    + '}catch(e){}}'
    + 'walkV(document,0);o.vids=V.slice(0,6);'
    // ⚠ 豆包把播放器塞在 iframe / 自定义元素里（2026-09-27：点开会话后 vids 仍为空）⇒ 再把"可能承载视频"的元素也报出来
    + 'var md=[];try{var cand=document.querySelectorAll(\'[class*="video"],[class*="player"],[data-src],[data-video],[src*=".mp4"],[poster]\');'
    + 'for(var q=0;q<cand.length&&md.length<8;q++){var el=cand[q];'
    + 'md.push((el.tagName||"?").toLowerCase()+"."+String(el.className||"").slice(0,36)+" src="+String(el.getAttribute("src")||el.getAttribute("data-src")||el.getAttribute("data-video")||el.getAttribute("poster")||"").slice(0,150));}}catch(e){}'
    + 'o.mediaDom=md;'
    // ⚠ 2026-09-27：点开会话后 `video` 仍为空、播放器却只有 div 壳 ⇒ 两路兜底：① 资源时间线里翻 mp4/m3u8（视频一旦被 fetch 过就有）
    //   ② 把视频块的 outerHTML 原样切一段回来，看清它到底是懒加载、还是塞在跨域 iframe 里。
    + 'var res=[];try{var es=performance.getEntriesByType("resource");for(var z=Math.max(0,es.length-90);z<es.length;z++){'
    + 'var nm=String(es[z].name||"");if(/\.mp4|m3u8|video|play|download/i.test(nm))res.push(nm.slice(0,220));}}catch(e){}'
    + 'o.res=res.slice(-10);'
    + 'try{var vb=document.querySelector(\'[class*="block-video"]\');o.vblock=vb?String(vb.outerHTML).slice(0,900):"";}catch(e){}'
    + 'o.links=[].slice.call(document.querySelectorAll("a[href]")).map(function(e){return String(e.href||"");})'
    + '.filter(function(s){return /\.mp4|\.mov|download|video/i.test(s);}).slice(0,8).map(function(s){return s.slice(0,300);});'
    // ⚠ 过滤器太窄会"看不见会话链接"（豆包侧栏是 `/chat/<id>`，不含 mp4/download/video 字样）⇒ 另附一份**不过滤**的 href+标题
    + 'o.hrefs=[].slice.call(document.querySelectorAll("a[href]")).slice(0,10).map(function(e){'
    + 'return (String(e.getAttribute("href")||"")+" | "+String(e.innerText||"").replace(/\\s+/g,"").slice(0,24)).slice(0,200);});'
    + '}catch(e){o.err=String(e);}return o;})()';

  // ---------- 页面上的图/视频清单（**穿 shadow DOM**，排掉 data:image/svg+xml 占位骨架） ----------
  var imgSrc = '(function(){var out=[];' +
    'function good(s,w,h,el){if(!s||w<480||h<360)return false;' +        // 门槛从 240x180 提到 480x360：实测 320x320 的头像会混进来当"成果图"
    '  if(w===h&&w<600)return false;' +                                   // 小方图基本是头像/logo/图标
    '  if(/^data:image\\/svg\\+xml/i.test(s))return false;' +          // 豆包的占位骨架长这样
    '  if(/^data:image\\/(gif|webp|png|jpe?g)/i.test(s)&&s.length<3000)return false;' +  // 极小的内联图
    '  var sig=((el&&typeof el.className==="string"?el.className:"")+" "+((el&&el.alt)||"")+" "+((el&&el.getAttribute&&el.getAttribute("aria-label"))||"")).slice(0,140);' +
    '  if(/avatar|logo|icon|emoji|head|badge|qrcode|二维码|头像|表情/i.test(sig))return false;' +
    '  return /^(https?:|blob:|data:)/.test(s);}' +
    'function walk(root,d){if(!root||d>6)return;' +
    '  var l=root.querySelectorAll?root.querySelectorAll("img,video"):[];' +
    '  for(var i=0;i<l.length;i++){var el=l[i];var s=el.currentSrc||el.src||"";' +
    '    if(el.tagName==="VIDEO"){if(s)out.push({src:s,w:el.videoWidth||0,h:el.videoHeight||0,video:true});}' +
    '    else{var w=el.naturalWidth||0,h=el.naturalHeight||0;if(good(s,w,h,el))out.push({src:s,w:w,h:h});}}' +
    '  var all=root.querySelectorAll?root.querySelectorAll("*"):[];' +
    '  for(var j=0;j<all.length;j++){var sr=all[j].shadowRoot;if(sr)walk(sr,d+1);}}' +
    'walk(document,0);return out.slice(-14);})()';

  // ---------- 把某张图抓成 dataURL（在页面上下文里 fetch ⇒ 带登录态，签名 CDN 也拿得到） ----------
  var oneSrc = function (src) {
    return '(async function(){var s=' + JSON.stringify(String(src)) + ';' +
      'try{var r=await fetch(s);var b=await r.blob();' +
      'if(b.size>3600000)return{ok:false,err:"图片太大 "+Math.round(b.size/1024)+"KB（中转上限约 3.5MB，请手动保存）"};' +
      'var d=await new Promise(function(res,rej){var fr=new FileReader();fr.onload=function(){res(fr.result)};fr.onerror=rej;fr.readAsDataURL(b);});' +
      'return{ok:true,data:d,type:b.type||"image/png",size:b.size};' +
      '}catch(e){return{ok:false,err:String((e&&e.message)||e)};}})()';
  };

  // ---------- 保底：把那张图滚到可见处，量出它的矩形（给 capturePage 用） ----------
  var rectSrc = function (src) {
    return '(function(){var s=' + JSON.stringify(String(src)) + ';var hit=null;' +
      'function walk(root,d){if(!root||d>6||hit)return;var l=root.querySelectorAll?root.querySelectorAll("img,video"):[];' +
      '  for(var i=0;i<l.length;i++){var el=l[i];if((el.currentSrc||el.src||"")===s){hit=el;return;}}' +
      '  var all=root.querySelectorAll?root.querySelectorAll("*"):[];' +
      '  for(var j=0;j<all.length;j++){if(all[j].shadowRoot)walk(all[j].shadowRoot,d+1);}}' +
      'walk(document,0);' +
      'if(!hit)return null;try{hit.scrollIntoView({block:"center",inline:"center"});}catch(e){}' +
      'var r=hit.getBoundingClientRect();var vw=innerWidth,vh=innerHeight;' +
      'var x=Math.max(0,r.left),y=Math.max(0,r.top);' +
      'var w=Math.min(r.right,vw)-x,h=Math.min(r.bottom,vh)-y;' +
      'if(w<50||h<50)return null;' +
      'return{x:x,y:y,w:w,h:h,full:Math.round(r.width)+"x"+Math.round(r.height)};})()';
  };

  // ---------- 取图：先 fetch 原图；被 CORS 挡住就截屏那块区域 ----------
  var grab = async function (wv, src) {
    var got = null;
    try { got = await wv.executeJavaScript(oneSrc(src), true); } catch (e) { got = { ok: false, err: String(e && e.message || e) }; }
    if (got && got.ok && got.data) return got;
    var why = (got && got.err) || '抓图失败';
    try {
      var r = await wv.executeJavaScript(rectSrc(src), true);
      if (r) {
        await sleep(500);
        var img = await wv.capturePage({
          x: Math.round(r.x), y: Math.round(r.y),
          width: Math.round(r.w), height: Math.round(r.h)
        });
        var d = img && img.toDataURL ? img.toDataURL() : '';
        if (d && d.length > 500) {
          return { ok: true, data: d, type: 'image/png', size: Math.round(d.length * 0.75), shot: true, why: why };
        }
      }
    } catch (e) { /* 截屏也不成，就报下面的错 */ }
    return { ok: false, err: why };
  };

  // ---------- 一次问答 ----------
  var handle = async function (task) {
    var t0 = Date.now();
    var key = String(task.key || '');
    var step = 'ensure';
    // [[save-img]] 是"这次要把图取回来"的开关（webai.mjs --save-image 加的），不能真发给网页版
    var wantImg = /\[\[save-img\]\]/.test(String(task.text || ''));
    var askText = String(task.text || '').replace(/\[\[save-img\]\]/g, '').trim();
    var note0 = '';
    try {
      curKey = String(key || '');
      // ★v3.23★ `[[self-reload]]`＝让**宿主渲染进程**自己重载一次（等同点一次工作台的 ⟳）。
      //   为什么必须自己来：桥活在宿主 renderer 里，而工作台的"自刷新通道"（scripts\刷新面板.mjs → main.js 轮询
      //   `data\reload-panels.cmd`）只重载 `getType()==='webview'` 的 webContents ⇒ **桥本身永远刷不到新版**，
      //   每次改完桥都得请人点 ⟳（2026-09-26 连点三次）。有了这条，会话自己就能把新桥装上，闭环。
      //   ⚠ 顺序：先让这一单正常回包（done 由 accept 在 handle 返回后才调），所以重载延迟 1.2 秒。
      if (/\[\[self-reload\]\]/.test(String(task.text || ''))) {
        say('🔁 self-reload：1.2 秒后重载宿主渲染进程（等于点一次 ⟳）');
        setTimeout(function () { try { location.reload(); } catch (e) { } }, 1200);
        return { ok: true, key: key, text: '已安排自重载（1.2 秒后生效，等于点一次 ⟳）', imgs: [] };
      }
      var wv = await ensureWv(key, Math.min(task.timeoutMs || 120000, 60000));
      // ★v3.19★ `[[peek]]`＝只看不派：**不往页面打字**，把这个页面"到底是什么样"原样报回来（走正常回包，脚本侧能拿到）。
      if (/\[\[peek\]\]/.test(String(task.text || ''))) {
        var pk = null;
        try { pk = await wv.executeJavaScript(peekSrc, true); } catch (e) { pk = { err: String((e && e.message) || e) }; }
        // ★v3.27★ 顺手把**取答脚本** readSrc 也在同一个页面上跑一次：等待循环里它的异常是被吞掉的
        //   （`catch { r = null }`）⇒ 它要是自己坏了，表现就是"发出去了、等满超时、回 0 字"，全程无声无息。
        try {
          var rs = await wv.executeJavaScript(readSrc, true);
          pk.readSrc = {
            ok: !!rs,
            len: rs && rs.len,
            busy: rs && rs.busy,
            textLen: String((rs && rs.text) || '').length,
            textTail: String((rs && rs.text) || '').slice(-160),
          };
        } catch (eR) { pk.readSrcErr = String((eR && eR.message) || eR); }
        say(key + ' 👀 peek：' + JSON.stringify(pk).slice(0, 260));
        // ⚠ 2800 太窄：带上 vids[].src（视频直链 ~700 字）就会被切掉尾巴（2026-09-27 实测 peek 拿不到完整 mp4 地址）
        return { ok: true, key: key, text: 'PEEK ' + JSON.stringify(pk).slice(0, 6000), imgs: [] };
      }
      // ★v3.34★ `[[goto:关键词]]` / `[[goto:url=http…]]`＝**让桥自己点开一条侧栏会话 / 跳个地址**（不往输入框打字）。
      //   为什么需要它（2026-09-27 实测）：豆包"视频生成好了"只存在于**那条会话**里，而宿主渲染层一自重载
      //   （`[[self-reload]]`，装新桥必须走这步）页面就退回首页 ⇒ 拿不到 `<video>` 的直链、视频就永远过不来。
      //   桥只会打字、不会点，于是补上这个"点开"原语：按标题关键词点侧栏链接（复用 v3.29 那套认人逻辑）。
      if (/\[\[goto:/.test(String(task.text || ''))) {
        var mg = String(task.text).match(/\[\[goto:([\s\S]*?)\]\]/);
        var gArg = mg ? mg[1].trim() : '';
        var gRes = '';
        try {
          if (/^url=/i.test(gArg)) {
            gRes = await wv.executeJavaScript('(function(){location.href=' + JSON.stringify(gArg.slice(4)) + ';return "nav";})()', true);
          } else {
            gRes = await wv.executeJavaScript('(function(){try{var q=' + JSON.stringify(gArg) + ';'
              + 'var as=[].slice.call(document.querySelectorAll("a[href]"));'
              + 'for(var i=0;i<as.length;i++){var h=as[i].getAttribute("href")||"";'
              + 'var tx=String(as[i].innerText||as[i].textContent||"").replace(/\\s+/g,"");'
              + 'if(tx&&tx.indexOf(q)>=0){try{as[i].click();}catch(e){}return "click:"+h;}}'
              + 'return "没找到标题含「"+q+"」的链接（共"+as.length+"个 a[href]）";}catch(e){return "err:"+e.message;}})()', true);
          }
        } catch (eG) { gRes = 'err:' + String(eG && eG.message || eG); }
        // 顺手把页面滚到底：这类站的播放器/图片是"滚到可见处才懒加载"（豆包实测点开会话后 video 仍为空）
        try { await wv.executeJavaScript('(function(){try{window.scrollTo(0,(document.scrollingElement||document.body).scrollHeight);}catch(e){}return 1;})()', true); } catch (eS) { }
        await sleep(2500);
        var gNow = '';
        try { gNow = await wv.executeJavaScript('location.href', true); } catch (eN) { gNow = '(读不到)'; }
        say(key + ' 🧭 goto：' + String(gRes).slice(0, 120) + ' → ' + String(gNow).slice(0, 90));
        return { ok: true, key: key, text: 'GOTO ' + gRes + ' → ' + gNow, imgs: [] };
      }
      // ★v3.35★ `[[click:选择器]]`＝按 CSS 选择器点页面上的第一个元素。
      //   为什么需要（2026-09-27 豆包实测）：视频块里 `div.video-player-*` 一直是**空壳**、`<video>` 是**点了播放才创建**的
      //   ⇒ 不点这一下，vids 永远为空、mp4 直链永远拿不到。点完再 `[[peek]]` 就能读到 vids[].src，
      //   然后**用 IWR 自己下**（不受桥 3.5MB 中转上限的约束，视频也能拿回来）。
      if (/\[\[click:/.test(String(task.text || ''))) {
        var mc = String(task.text).match(/\[\[click:([\s\S]*)\]\]/);
        var cSel = mc ? mc[1].trim().replace(/^["']|["']$/g, '') : '';
        var cRes = '';
        try {
          cRes = await wv.executeJavaScript('(function(){try{var sel=' + JSON.stringify(cSel) + ';var el=document.querySelector(sel);'
            + 'if(!el)return "没找到 "+sel;'
            + 'try{el.scrollIntoView({block:"center"});}catch(e){}'
            + 'try{el.click();}catch(e){}'
            + 'var v=document.querySelector("video");'
            + 'return "clicked "+(el.tagName||"?")+"."+String(el.className||"").slice(0,40)+" | video:"+(v?String(v.currentSrc||v.src||"").slice(0,120):"还没有");'
            + '}catch(e){return "err:"+((e&&e.message)||e);}})()', true);
        } catch (eC) { cRes = 'err:' + String(eC && eC.message || eC); }
        await sleep(3000);
        var cNow = '';
        try { cNow = await wv.executeJavaScript('(function(){var v=document.querySelector("video");return v?String(v.currentSrc||v.src||""):"(仍无 video)";})()', true); } catch (eN) { cNow = '(读不到)'; }
        say(key + ' 👆 click：' + String(cRes).slice(0, 130));
        return { ok: true, key: key, text: 'CLICK ' + cRes + ' → ' + cNow, imgs: [] };
      }
      // ★v3.24★ 打字/发送要用 Electron 的**输入事件**（`wv.sendInputEvent` / `wv.focus()` / 真回车那一串），
      //   而输入事件要求 guest **挂在一个可见窗口上**；`executeJavaScript` 不需要（它走 guest 内部）
      //   ⇒ 于是会出现一种很误导人的现象：**`[[peek]]` 0 秒正常，同一分钟派活必 `GUEST_VIEW_MANAGER_CALL` 秒失败**
      //   （实测 2026-09-26 15:0x，差点又误判成"站点改版"）。
      //   修法：打字之前**主动请界面把窗口显示出来**（`__kunWebAiEnsure` → renderers.js 的 `webAiShow`
      //   ＋必要时 `webAiRebuildGuest`）。它只"显示/重建"，不会关掉用户正开着的窗口。
      // ★v3.26★ 顺序反了要命：v3.24 是"**先 show 再打字**"，但 `__kunWebAiEnsure` 会**重建** guest，
      //   把本来活着的页面弄坏 —— 实测（2026-09-26 16:5x 重启后）铁证：`[[peek]]` **0 秒通过**
      //   （= `executeJavaScript` 完全好使、guest 活着），同一分钟的真问却必 `[type] GUEST_VIEW_MANAGER_CALL`。
      //   现在改成 **先直接打字**；只有打字真失败（guest 确实不在了）才请界面显示/重建，然后重试一次。
      step = 'type';
      // 输入框里若有**上次没发出去的残留**：先试**页面内**清（不依赖输入事件，guest 没挂可见窗口时也能用），
      // 不行再用"真键盘"Ctrl+A + 退格 —— 页面内的 execCommand("selectAll")/Range 选区在这类编辑器上靠不住
      // （实测 DeepSeek：文字只会一层层叠上去，发出去的是"旧需求+旧问题+这次问题"的缝合怪）。
      try {
        var bx = await wv.executeJavaScript('(function(){var b=document.querySelector("textarea")||document.querySelector(\'[contenteditable="true"]\');if(!b)return null;var t=b.isContentEditable?(b.innerText||""):(b.value||"");return{ce:!!b.isContentEditable,text:t};})()', true);
        if (bx && bx.ce && bx.text && bx.text.trim()) {
          var cl = false;
          try {
            cl = !!(await wv.executeJavaScript('(function(){var b=document.querySelector(\'[contenteditable="true"]\')||document.querySelector("textarea");if(!b)return false;try{b.focus();}catch(e){}try{document.execCommand("selectAll",false,null);document.execCommand("delete",false,null);}catch(e){}var t=b.isContentEditable?(b.innerText||""):(b.value||"");if(t.trim()){if(b.isContentEditable){b.innerHTML="";}else{b.value="";}try{b.dispatchEvent(new InputEvent("input",{bubbles:true}));}catch(e){}}return !((b.isContentEditable?(b.innerText||""):(b.value||"")).trim());})()', true));
          } catch (e2) { }
          if (cl) {
            say(key + ' 输入框有残留（' + bx.text.trim().slice(0, 24) + '…）⇒ 页面内清干净了');
          } else {
            // ⛔ 这里原来还有"真键盘 Ctrl+A + 退格"一条路 —— 已删除：`wv.focus()` / `sendInputEvent` 正是
            //   唯一会抛 `GUEST_VIEW_MANAGER_CALL` 的东西，实测（2026-09-26 17:0x）它会**把好端端的 guest 弄坏**，
            //   而被 try 吞掉后没人看得出来 —— 表现就是"peek 0 秒通、真问必挂"。
            //   清不干净就带着残留往前：注入脚本自己会检测并把"旧内容+新问题"标成 polluted，回包时提醒。
            say(key + ' 输入框有残留（' + bx.text.trim().slice(0, 24) + '…）⇒ 页面内清不掉，带着残留往前（会报 polluted）');
          }
        }
      } catch (e) { }
      // ★v3.27★ 现场快照只留**最便宜的两条**（最小脚本 + url），而且**只在失败时才拍**（成功路径零开销）：
      //   2026-09-26 那次"真问必挂、peek 必通"最后查出是注入脚本里 `NaNbox is not defined`（我自己的手误），
      //   而错误原文被 Electron 包了一层、又被我截断 ⇒ 白查两小时。留这两条够分清"人没了还是脚本坏了"。
      var probe = '';
      var a = null;
      // ⚠ 第一遍**只试一次**（tries=1）：`runIn` 的重试里会请界面重建 guest，那会把"第一次到底为什么错"这个
      //   最重要的线索抹掉（抛出来的其实是第 3 次的错）。诊断期必须看第一手错误。
      // ★v3.27★ 再加一条"卡住"判据：页面内脚本若**一直不返回**（等一个已经改版的元素/等一个永不到来的信号），
      //   Electron 那条 IPC 会悬着，最后报出来的却是 GUEST_VIEW_MANAGER_CALL —— 极易误判成"guest 死了"。
      //   宿主侧给它 6 秒，超时就把"卡住"这个真相写进报错。
      try {
        a = await Promise.race([
          runIn(wv, askSrc(askText), 1),
          sleep(6000).then(function () { return { ok: false, err: '页面内脚本 6 秒没返回（卡住 = 它等的元素已经不在了），不是 guest 死了' }; }),
        ]);
      }
      catch (e0) {
        var emsg = String((e0 && e0.message) || e0);
        // ★v3.31★ 页面上找不到输入框 ⇒ 那个窗口多半停在一个**带弹层的旧会话**上（实测豆包：分享图片预览弹层
        //   把编辑器挡住了）⇒ 刷新一下页面再试一次，比让人去手动关弹层快得多。
        if (/找不到输入框/.test(emsg)) {
          step = 'reload';
          say(key + ' 页面上找不到输入框（可能停在旧会话/弹层上）⇒ 刷新页面后重试一次');
          try { wv.reload(); } catch (e1) { }
          await sleep(4500);
          step = 'type';
          try { a = await runIn(wv, askSrc(askText), 1); } catch (e3) { a = null; }
        } else if (/GUEST_VIEW_MANAGER_CALL|must be attached|destroyed|not attached|guest view/i.test(emsg)) {
          // 第一遍就打不进去（guest 真的没了）才请界面显示/重建，再给一次机会
          step = 'show';
          say(key + ' 的 guest 进不去 ⇒ 请界面显示/重建，准备重试打字');
          try { if (window.__kunWebAiEnsure) window.__kunWebAiEnsure(key); } catch (e2) { }
          await sleep(800);
          step = 'type';
          try { a = await runIn(wv, askSrc(askText)); } catch (e3) { a = null; }
        }
        // 到这儿还进不去＝那个网页版窗口**没挂在页面上**，脚本进不去它的页面。
        // 渲染层这边没法替它挂（挂载要经 renderers.js），所以直接把"怎么办"写在报错里 —— 原来这里只报 electron 的原话，看不懂。
        if (!a) {
          // 失败才拍现场：最小脚本还通 ⇒ 页面/guest 都在，问题在注入脚本自己（就是这次踩的坑）
          try { probe = '最小脚本=' + String(await runIn(wv, '"ok"', 1)); } catch (eP) { probe = '最小脚本挂了:' + String((eP && eP.message) || eP).slice(0, 60); }
          try { probe += ' / url=' + String(wv.getURL() || '(空)'); } catch (eU) { /* ignore */ }
          // ⚠ 这里**不再截断**错误原文：`GUEST_VIEW_MANAGER_CALL` 后面跟着的才是真原因，截了就白查。
          throw new Error('进不去 ' + key + ' 的页面（' + String((e0 && e0.message) || e0) +
            '）【现场：' + probe + '】—— 点顶栏那个 ' + key + ' 图标把它的窗口打开、或点它标题栏的 ⟳，再问一次');
        }
      }
      // ★v3.32★ 注意：`askSrc` 遇到"页面上找不到输入框"是**正常返回 `{ok:false,err:…}`**（不是抛错）⇒
      //   重试必须挂在这儿，挂在上面的 catch 里一辈子等不到（实测 v3.31 就是这么哑掉的 ✗）。
      if (!a || !a.ok) {
        var aerr = String((a && a.err) || '');
        if (/找不到输入框/.test(aerr)) {
          step = 'reload';
          say(key + ' 页面上找不到输入框（多半停在旧会话/弹层上）⇒ 刷新页面后重试一次');
          try { wv.reload(); } catch (eR1) { }
          await sleep(5000);
          step = 'type';
          try { a = await runIn(wv, askSrc(askText), 1); } catch (e4) { a = null; }
        }
      }
      if (!a || !a.ok) throw new Error((a && a.err) || '输入失败');
      var polluteWarn = !!a.polluted;
      if (polluteWarn) note0 = '\n\n[[webai-note:⚠ 输入框里本来就有残留内容，这次是"旧内容+我的问题"拼着发出去的 —— 建议在那个窗口手动清空输入框]]';
      // ★★★ v3.17 一次性修好：发送一律"以事实为准"复查 + 逐级补救 ★★★
      // 这里原来是个致命漏洞：补按真回车、补点发送键**都挂在 `if (sendWarn)` 里**，而 sendWarn 来自注入脚本的
      //   `a.sent === false`。DeepSeek 的编辑器恰恰是"脚本以为发出去了（sent:true）、实际没发出去"⇒ 两条补救
      //   一条都不跑，然后一路干等到超时（实测 188 秒 / 页面一个字没长 / 回 0 字）。
      //   ⇒ 判据改成**只认事实**：问话还留在输入框里就是没发出去，脚本怎么说都不算。
      //   顺序是刻意的（从"最不打扰页面"到"最打扰"）：① 真回车 → ② 真 Return → ③ 只点发送键的小脚本 → ④ 报错收工。
      //   ③ 刻意不重跑整段注入脚本：那样会把同一句话发两遍。
      var boxText = async function () {
        try {
          return String(await wv.executeJavaScript('(function(){var b=document.querySelector("textarea")||document.querySelector(\'[contenteditable="true"]\');return b?((b.isContentEditable?b.innerText:b.value)||""):"";})()', true) || '');
        } catch (e) { return ''; }
      };
      var notSent = (await boxText()).indexOf(askText.slice(0, 8)) >= 0;
      // ★2026-09-30★ "页面长字了"这件事**必须带证据**：光看整页字数涨 60，会把"点错工具键把面板打开"
      //   当成发出去了（当天通义就是这么假成功的：问题还躺在框里、回来的是 PPT 模板墙）。
      //   问话真发出去 ⇒ 一定在**输入框之外**（消息区）留下回显 ⇒ 拿它当硬证据。
      var outsideEcho = async function () {
        try {
          return !!(await wv.executeJavaScript(
            '(function(){try{var t=' + JSON.stringify(askText.slice(0, 10)) + ';' +
            'var ed=document.querySelector(\'textarea, [contenteditable="true"]\');' +
            'var bx=ed?String((ed.isContentEditable?ed.innerText:ed.value)||""):"";' +
            'var now=String((document.body&&document.body.innerText)||"");' +
            'var out=bx?now.split(bx).join(""):now;return out.indexOf(t)>=0;}catch(e){return false;}})()', true));
        } catch (e) { return false; }
      };
      // ★硬证据优先：页面字数长出来了**且问话在框外出现** ⇒ 一定发出去了（框里留着字也没关系）★
      // 通义/智谱这类站"发出去之后输入框不变空"，只按框判会误判成没发出去、一路白补、最后抛错。
      var pageGrew = (typeof a.pageLen === 'number' && a.pageLen >= 0 && typeof a.len === 'number' && a.pageLen >= a.len + 60);
      if (pageGrew && notSent && (await outsideEcho())) {
        say(key + ' 输入框里还留着问话，但**页面已经长了 ' + (a.pageLen - a.len) + ' 字且问话出现在消息区** ⇒ 判定已发出（这类站不清空输入框）');
        notSent = false;
      } else if (pageGrew && notSent) {
        say(key + ' ⚠ 页面虽长了 ' + (a.pageLen - a.len) + ' 字，但**问话没出现在消息区** ⇒ 当作没发出去（那是别的东西撑大的，2026-09-30 通义点开面板就这么骗过一次）');
      }
      if (notSent) {
        // ★2026-09-30★ 效率优化：注入脚本带回的 `sendState` 说发送键**本来就是禁用态**时，说明站点压根没认下
        //   注入的文字（内部状态空 ⇒ 键自己 disabled）⇒ 合成回车/Return/click 三种补法**必然无效**，
        //   跑它们只是白白多花 5~6 秒。直接跳过、立刻走下面的真键盘通道（通义实测：省 6 秒）。
        if (a.sendState === '禁用') {
          say(key + ' 发送键是**禁用态**（站点没认下注入的文字）⇒ 跳过合成回车/点击，直接走真键盘通道');
        } else {
        say(key + ' ⚠ 问话没发出去（框里还留着）⇒ 逐级补：真回车 → 真 Return → 点发送键');
        try {
          wv.focus();
          wv.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
          wv.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
          await sleep(1500);
          notSent = (await boxText()).indexOf(askText.slice(0, 8)) >= 0;
          if (notSent) {
            wv.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
            wv.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
            await sleep(1500);
            notSent = (await boxText()).indexOf(askText.slice(0, 8)) >= 0;
          }
        } catch (e) { }
        if (notSent) {
          try {
            var re = await wv.executeJavaScript(
              '(function(){var t=' + JSON.stringify(askText.slice(0, 12)) + ';' +
              'var ed=document.querySelector(\'textarea, [contenteditable="true"]\');' +
              'var lf=ed?((ed.isContentEditable?ed.innerText:ed.value)||""):"";' +
              'if(lf.indexOf(t)<0)return{skip:1};' +
              'var bs=Array.prototype.slice.call(document.querySelectorAll("button,[role=button],[class*=send],[class*=submit]"));' +
              'for(var i=bs.length-1;i>=0;i--){var b=bs[i],r=b.getBoundingClientRect();' +
              'if(r.width<12||r.height<12||r.top<innerHeight*0.35)continue;' +
              'var n=((b.getAttribute("aria-label")||"")+" "+(b.className||"")+" "+(b.textContent||"")).toLowerCase();' +
              'if(/send|发送|提交/.test(n)){b.click();return{clicked:1};}}' +
              'return{clicked:0};})()', true);
            if (re && re.clicked) { say(key + ' 补点了一次发送键'); await sleep(1500); }
            notSent = (await boxText()).indexOf(askText.slice(0, 8)) >= 0;
          } catch (e) { }
        }
        }   // ← 收 `a.sendState==='禁用'` 的 else（禁用态时上面的补法跳过）
      }
      // ★2026-09-30★ ⑤ **真键盘通道**（通义必须走这条，实测）：qianwen.com 的输入框是"自研编辑器 + 防机器"——
      //   注入脚本能把字写进 DOM（人看得见），可站点内部状态还是空 ⇒ 发送键（`aria-label=发送消息`）一直挂着
      //   `disabled / cursor:not-allowed`，**点它、按合成回车全都没用**。当天用新增的 `[[peek]] nearBox` 实测到：
      //   `BUTTON...|发送消息|32x32|pe:auto|cur:not-allowed|DISABLED` —— 这就是"输入内容能看到但点不了"的真相。
      //   对策：清空编辑框 → `wv.focus()` + `wv.insertText()` 走 Electron 的**真输入**通道（编辑器认这个，
      //   它的内部状态会跟着更新 → 发送键自己变成可用）→ 再用真回车发一次。
      //   ⚠ 这是**最后兜底**，只在前面四种补法全失败时才跑 ⇒ 不会打扰本来正常的站。
      var trustedWhy = '';
      try {
        var clr = await wv.executeJavaScript(
          '(function(){try{var ed=document.querySelector(\'textarea, [contenteditable="true"]\');if(!ed)return{ok:0,err:"找不到编辑框"};' +
          'ed.focus();if(ed.isContentEditable){document.execCommand("selectAll",false,null);document.execCommand("delete",false,null);}' +
          'else{ed.value="";ed.dispatchEvent(new Event("input",{bubbles:true}));}return{ok:1};}catch(e){return{ok:0,err:String((e&&e.message)||e)};}})()', true);
        if (!clr || !clr.ok) {
          trustedWhy += '清空编辑框失败(' + String((clr && clr.err) || '?') + ')；';
        } else {
          try { wv.focus(); } catch (eF) { trustedWhy += 'focus:' + String((eF && eF.message) || eF) + '；'; }
          // 2026-10-26：DeepSeek 这类站只认真实用户聚焦；只 wv.focus() 有时不算，先在输入框真实点一下。
          try {
            var rct = await wv.executeJavaScript('(function(){var b=document.querySelector(\'textarea, [contenteditable="true"]\');if(!b)return null;var r=b.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+Math.min(r.height/2,40),w:r.width,h:r.height};})()', true);
            if (rct && rct.w > 0) {
              var mx = Math.round(rct.x), my = Math.round(rct.y);
              wv.sendInputEvent({ type: 'mouseDown', x: mx, y: my, button: 'left', clickCount: 1 });
              wv.sendInputEvent({ type: 'mouseUp', x: mx, y: my, button: 'left', clickCount: 1 });
              await sleep(200);
            }
          } catch (eClick) { trustedWhy += 'clickFocus:' + String((eClick && eClick.message) || eClick) + '；'; }
          if (typeof wv.insertText === 'function') {
            try { wv.insertText(askText); }                  // Electron 真输入：编辑器内部状态会跟着更新
            catch (eI) { trustedWhy += 'insertText:' + String((eI && eI.message) || eI) + '；'; }
          } else { trustedWhy += '这个 Electron 的 webview 没有 insertText()；'; }
          await sleep(500);
          if ((await boxText()).indexOf(askText.slice(0, 8)) < 0) {
            // insertText 没生效（或没这个 API）⇒ 退到"一个字符一个字符发真按键"（慢，但最像人在打字）
            var chars = askText.slice(0, 400).split('');
            for (var ci = 0; ci < chars.length; ci++) {
              try { wv.sendInputEvent({ type: 'char', keyCode: chars[ci] }); }
              catch (eC) { trustedWhy += 'char:' + String((eC && eC.message) || eC) + '；'; break; }
            }
            await sleep(500);
          }
          var afterType = await boxText();
          var btnState = '';
          try {
            btnState = String(await wv.executeJavaScript(
              '(function(){try{var a=document.querySelectorAll(\'button,[role=button],[class*=send]\');' +
              'for(var i=0;i<a.length;i++){var n=((a[i].getAttribute("aria-label")||"")+" "+(a[i].className||"")+" "+(a[i].textContent||""));' +
              'if(!/send|发送|提交/i.test(n))continue;return (a[i].disabled||a[i].getAttribute("aria-disabled")==="true")?"禁用":"可用";}return "没找到";}catch(e){return "err";}})()', true) || '');
          } catch (eB) { }
          say(key + ' 🔤 真键盘通道：框里' + (afterType.indexOf(askText.slice(0, 8)) >= 0 ? '有字' : '没字') + '、发送键' + btnState);
          try {
            wv.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
            wv.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
          } catch (eE) { trustedWhy += '真回车:' + String((eE && eE.message) || eE) + '；'; }
          await sleep(2500);
          notSent = (await boxText()).indexOf(askText.slice(0, 8)) >= 0;
          if (notSent) {
            try {
              var re2 = await wv.executeJavaScript(
                '(function(){var bs=document.querySelectorAll(\'button,[role=button],[class*=send]\');' +
                'for(var i=bs.length-1;i>=0;i--){var b=bs[i];var n=((b.getAttribute("aria-label")||"")+" "+(b.className||""));' +
                'if(!/send|发送|提交/i.test(n))continue;if(b.disabled||b.getAttribute("aria-disabled")==="true")continue;' +
                'b.click();return 1;}return 0;})()', true);
              if (re2) { say(key + ' 真键盘通道后又补点了一次（这回只点**可用**的发送键）'); await sleep(1800); notSent = (await boxText()).indexOf(askText.slice(0, 8)) >= 0; }
            } catch (e2) { }
          }
        }
      } catch (eT) { trustedWhy += '真键盘通道整个挂了：' + String((eT && eT.message) || eT) + '；'; }
      if (notSent) {
        // 五种补法都没送出去 ⇒ 别装作在等回答；直接失败，并把"你该做什么"写进报错里
        // ★2026-09-30★ 失败时把 askSrc 早就带回来的**输入框附近按钮清单**（`btns`）、框信息、发送前后整页字数
        //   一起写进报错。以前这些现场数据被整个丢掉，只能让人去那个窗口截图猜（千问当天就是这么卡住的：
        //   报错只说"没发出去"，看不出是"发送键是禁用态"还是"根本没找到发送键"）。
        var diag = '';
        try {
          diag = '【现场】框=' + String(a.where || '?') + '；候选框=' + String(a.boxInfo || '?').slice(0, 120)
            + '；整页 ' + String(a.len) + ' 字 → 补发后 ' + String(a.pageLen) + ' 字'
            + '；框右下方元素=' + JSON.stringify((a.btns || []).slice(0, 8));
        } catch (eD) { diag = ''; }
        say(key + ' ⛔ 问话最终没发出去（真回车 / 真 Return / 点发送键 / 真键盘通道都没用）—— 发送键可能改版了，先在那个窗口手动发一条试试');
        throw new Error('问话没能发出去（还留在输入框里）—— 点顶栏那个 ' + key + ' 图标，手动发一条看看是不是改版了；' +
          '若手动也不动，多半是没登录/要过验证码。' + diag + (trustedWhy ? '【真键盘通道】' + trustedWhy : ''));
      }
      say(key + ' 已输入（' + a.where + '）' + (polluteWarn ? '，⚠ 框里有残留' : '，等回答…'));
      var before = String(a.before || '');
      var beforeImgs = Array.isArray(a.imgs) ? a.imgs : [];

      step = 'wait';
      var cap = Math.max(20000, Math.min(task.timeoutMs || 120000, 600000));
      var lastLen = -1, stable = 0, txt = '', busy = false;
      // ⚠ base 必须是**整页字数**。a.before 只带回最后 2500 字 ⇒ 早先拿它当基准，页面本来就短于 2500 字的站（豆包新会话）
      // 永远满足不了"涨 3 个字"，于是"它明明答了收到"却被判成"没看到它开始回答"（实测白等 90 秒）。
      var base = (typeof a.len === 'number' ? a.len : before.length);
      // ★2026-09-26★ 兜底阈值按站取；页面长度 >40000 时 readSrc 只带回**尾部 40000 字** ⇒ 长度加减算不准，
      //   这时不用 core 判（退回老口径），免得慢站永远等不到兜底、白白拖到硬超时。
      // ★2026-09-30★ **问话越长，兜底安静期越要放宽**：原来的兜底只有 20 秒（豆包 75 秒），
      //   可"让 AI 写口播稿"这种 600~1500 字的长提示词，它光组织答案就要 30~60 秒 ⇒ 20 秒收工时页面上
      //   只有"我问话的回声"，取回来就是**把用户的要求原样复述了一遍**（实测 2026-09-30 连中三次，
      //   用户看到的就是"它没答，只复读了我的要求"）。
      //   公式：20 秒 + 问话每字 60ms，封顶 90 秒（短问话几乎不变：20 字 ⇒ 21 秒，跟原来一样）。
      var quietCap = Math.max(quietCapOf(key), Math.min(90000, 20000 + askText.length * 60));
      var lenTrusted = base < 39000;
      var diag = '（结构法没取到）';   // ⚠ 提前声明：超时诊断（下面）就要往里加话，别等到结构法那段才 var
      var started = false, firstChange = 0;    // 有没有"它开始答了"的证据
      var entered = false;                     // ★v3.28★ 有没有试过"点进最新会话"（见循环里那段）
      var everBusy = false, lastChange = Date.now();
      var lastImgs = [];
      while (Date.now() - t0 < cap) {
        await sleep(1500);
        var r = null;
        try { r = await wv.executeJavaScript(readSrc, true); } catch (e) { r = null; }
        if (!r) continue;                       // 页面正在导航/重载，下一轮再说
        txt = String(r.text || ''); busy = !!r.busy;
        // ★v3.28★ "发出去了、页面就是不涨"的另一种真相：**站点把会话建在了另一个视图里**。
        //   实测（2026-09-26 17:00 豆包）：在首页提问 ⇒ 会话真建了、也真答了（侧栏能看见「… ABCD」），
        //   但主页一个字不变 ⇒ 我们一路干等到超时、回 0 字。对策：还没开始答、且已经在页面上待够 8 秒，
        //   就点进**最新那条会话**（链接里带数字/长 id 的第一个）再看 —— 一次性，不反复点。
        if (!started && !entered && !busy && Date.now() - t0 > 8000) {
          entered = true;
          // ★v3.29★ 这条兜底**必须认人**：原来只按 DOM 顺序点"第一个带会话 id 的链接" ⇒ 实测点进了
          //   **旧会话**（「收到」那条），把正在等的这一问整个换走 ⇒ 白等 181 秒、只抓回 15 字界面词 ✗。
          //   现在两道闸：① 已经在会话页（URL 带长 id）就**什么都不点**；② 要点就只点**标题里含我这句话前 8 字**的那条。
          try {
            var ent = await wv.executeJavaScript('(function(){try{var q=' + JSON.stringify(String(askText || '').slice(0, 8)) + ';'
              + 'if(/\\/(chat|conversation|c|s)\\/[0-9a-zA-Z_-]{8,}/.test(location.pathname))return "";'   // ① 已经在会话里 ⇒ 不打扰
              + 'var as=[].slice.call(document.querySelectorAll("a[href]"));'
              + 'for(var i=0;i<as.length;i++){var h=as[i].getAttribute("href")||"";'
              + 'if(!/\\/(chat|conversation|c|s)\\/[0-9a-zA-Z_-]{6,}/.test(h))continue;'
              + 'var tx=String(as[i].innerText||as[i].textContent||"").replace(/\\s+/g,"");'
              + 'if(q&&tx.indexOf(q)>=0){try{as[i].click();}catch(e){}return h;}}'
              + 'return "";}catch(e){return "";}})()', true);
            if (ent) say(key + ' 页面没动静 ⇒ 点进"标题含我这句话"的那条会话再看看（' + String(ent).slice(0, 70) + '）');
          } catch (e) { }
        }
        if (busy) { started = true; everBusy = true; }               // 页面上有"停止/思考中" ⇒ 正在生成
        if (r.len > base + 3) { started = true; if (!firstChange) firstChange = Date.now(); }   // 涨 3 个字就算开始了：回答可能只有"收到"两个字（原来要涨 30 字 ⇒ 豆包答了也被判成没开始）
        if (r.len === lastLen) stable++; else { stable = 0; lastLen = r.len; lastChange = Date.now(); }
        // ⚠ 判"说完了"不能只看"页面不动了"：模型闷头思考时页面会静止十几秒（实测 DeepSeek 因此只回了个问题回声）。
        // 规则：① 正文像样(≥20 字)且安静 3 秒；② 见过"停止/思考中"⇒安静 3 秒且正文 ≥8 字；
        //       ③ 页面上出现"已思考/思考结束/用时 N 秒/重新生成"这类完事标记；④ 兜底 quietCap 秒。
        // ⚠ 2026-09-26 修：④ 这条兜底原来写死 20 秒、且不要求"真的长过我的提问回声" ⇒ 豆包（纯文字 45~60s）会在
        //   思考期被它收工，切出来的是**提问本身**（ok:true 却是错内容，比超时更坏）。现在：慢站放宽（QUIET_CAP）
        //   + 兜底要求 core>=2（页面比"回声"多长出 2 字以上才算答了）；长度不可信（超 40000 字）时不加这条。
        if (started && !busy) {
          var quiet = Date.now() - lastChange;
          var core = txt.length - base - askText.length;             // 粗略去掉"我们的问话回声"后的正文量
          var doneHint = /已思考|思考结束|用时\s*\d+\s*秒|重新生成|重新回答|Regenerate/i.test(txt.slice(-800));
          // ★2026-09-30★ `doneHint` 必须**伴随正文真的长出来**（core>=2）才算完事：
          //   页面上**上一条回答**的"已思考/重新生成"标记会一直挂着 ⇒ 光看它会在本条还没答时就收工，
          //   切回来的正好是"我问话的回声"（实测 2026-09-30 长提示词连中两次，用户看到的就是"它把我的要求复述了一遍"）。
          if ((core >= 20 && quiet >= 3000) || (everBusy && core >= 8 && quiet >= 3000) || (doneHint && quiet >= 3000 && core >= 2) || (quiet >= quietCap && (!lenTrusted || core >= 2))) break;
        }
        // 想省事：文字已经稳但还在等图时，顺手看看真图来了没（放在循环里 = 边长边等）
        if (wantImg && stable >= 2 && !busy) {
          try { lastImgs = asImgs(await wv.executeJavaScript(imgSrc, true)); } catch (e) { lastImgs = []; }
          if (lastImgs.some(function (i) { return !i.video && beforeImgs.indexOf(i.src) < 0; })) break;
        }
      }
      var timedOut = (Date.now() - t0) >= cap;
      // ★v3.17：一个字都没等到时，必须回答"问话发出去了吗"★
      // 为什么：DeepSeek 实测 188 秒 0 字，而"没发出去"和"发了但没回"处理方式完全不同
      //   （前者要修发送键/改版，后者是站点在排队/限流）。原来两种情况都只报"超时"，没法定位。
      //   判据：输入框里还留着问话原文 ⇒ 没发出去（发送键没按动）；框空了 ⇒ 发出去了，问题在站点侧。
      if (!started && timedOut) {
        try {
          var leftNow = String(await wv.executeJavaScript('(function(){var b=document.querySelector("textarea")||document.querySelector(\'[contenteditable="true"]\');return b?((b.isContentEditable?b.innerText:b.value)||""):"";})()', true) || '');
          var kept = leftNow.indexOf(askText.slice(0, 8)) >= 0;
          say(key + ' ⏱ ' + Math.round((Date.now() - t0) / 1000) + 's 内页面没动静；问话' +
            (kept ? '**还留在输入框里 ⇒ 压根没发出去**（发送键没按动/站点改版）' : '已经出了输入框 ⇒ 发出去了，是站点侧没回（排队/限流/额度）'));
        } catch (e) { }
        diag += '（⚠ ' + Math.round((Date.now() - t0) / 1000) + 's 内页面文字没长过 —— 见 stderr 里那条"问话发出去没有"）';
      }

      // ---------- 从整页文本里切出"这次的回答" ----------
      // 关键：这类页面的**底部工具条是固定的**，会话内容长在中间。所以：
      //   起点 = 我这句问话的最后一次回声（各家都会把用户消息回显）；终点 = 底部工具条第一次出现的位置。
      // 早先拿"发问前最后 120 字"当**起点**往后切 ⇒ 永远切出 0 字（实测：智谱/豆包明明答了"收到"，却被切成空 ✗）
      var answer = txt;
      var qa = askText.slice(0, 24);
      var full = askText.trim();
      var chrome = before.slice(-120);
      // ---------- 分界线（v3.16）：公共前缀 = 发问前就存在的那部分页面 ----------
      // 落在它**之后**的块才是这次问答长出来的。没有它，DeepSeek 会稳定回上一次对话（实测：问"收到收到"，答"深蓝S07 汽车尺寸"）。
      var CP = (function (a, b) {
        var n = Math.min(a.length, b.length), i = 0;
        while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
        return i;
      })(before, txt);
      var cutAnchor = before.slice(-260).replace(/\s+/g, ' ').trim().slice(-60);   // 页面里找得到它 ⇒ 分界线就在它下面
      var cutInfo = { anchor: cutAnchor, len: cutAnchor.length };
      // 页脚/固定提示条：出现即"正文到头了"。只放**一定在回答之后**的句子——
      // 侧边栏里的"API 服务/订阅会员"这类绝不能当终点（会把整段回答切没，通义就长这样）。
      var TAIL = /内容由\s*AI\s*生成|请仔细甄别/;
      var start = -1;
      if (qa) start = txt.lastIndexOf(qa);
      if (start >= 0) {
        // 回声是**整句问话**：能整句匹配就整句跳过（只跳 24 字会把问话尾巴当正文开头 ✗）
        start = (full && txt.slice(start, start + full.length) === full) ? start + full.length : start + qa.length;
      } else if (chrome) { var c0 = txt.indexOf(chrome); start = c0 >= 0 ? c0 + chrome.length : 0; }
      if (start < 0) start = 0;
      var e1 = chrome ? txt.indexOf(chrome, start) : -1;
      var m2 = TAIL.exec(txt.slice(start));
      var e2 = m2 ? start + m2.index : -1;
      var end = (e1 >= 0 && e2 >= 0) ? Math.min(e1, e2) : (e1 >= 0 ? e1 : e2);
      answer = txt.slice(start, end >= 0 ? end : undefined);
      if (qa) {                                  // 紧跟其后的重复回声（有的站点把用户消息渲染两遍）也切掉
        var qi = answer.indexOf(qa);
        if (qi >= 0 && qi < 300) answer = answer.slice(qi + qa.length);
      }
      answer = answer.replace(/^\s+/, '');
      // ---------- 正文提取 A（v3.12 首选）：结构定位，取"消息容器里最后一个 != 问话回声的块" ----------
      // 老的尾部切片（上面那段）保留为兜底：它遇到站点改版/侧栏文案多时会切错，但结构法偶尔也会挑错容器 ⇒ 用**长度**仲裁。
      var diag = '（结构法没取到）';   // 已提前声明过，这里只是复位
      try {
        // 不必把输入框传进去：结构法自己会跳过"问话回声块"（见 BLOCKS_SRC 的 pick()）
        var bres = await wv.executeJavaScript(BLOCKS_SRC + JSON.stringify(askText) + ',null,' + JSON.stringify(cutInfo) + ')', true);
        var blkLen = (bres && bres.ok) ? String(bres.text || '').replace(/\s+/g, '').length : 0;
        var slcLen = answer.replace(/\s+/g, '').length;
        // 结构法也可能整段选到"侧栏/菜单墙"（实测豆包：回了一屏 `新工作任务 Ctrl J / 新对话 Ctrl Shift K / …`，427 字）。
        // 判据：整段没有句末标点 + 大多是 ≤12 字的短行 ⇒ 当它是菜单，宁可用尾部切片。
        var blkMenu = false;
        if (blkLen > 0 && bres && bres.text) {
          var bs = String(bres.text);
          var bl = bs.split('\n'), bn = 0, bsum = 0;
          for (var bi = 0; bi < bl.length; bi++) { var bx = bl[bi].trim(); if (!bx) continue; bn++; bsum += bx.length; }
          blkMenu = bs.length >= 40 && !/[,，。！？；;]/.test(bs) && bn >= 5 && bsum / bn <= 16;
        }
        if (blkMenu) {
          diag = '（结构法取到的像页面菜单（' + blkLen + ' 字），已弃用）';
        } else if (blkLen >= 8 && blkLen >= slcLen) {
          say(key + ' 正文用结构法（' + bres.blocks + ' 块，取第 ' + (bres.idx + 1) + ' 块，候选 ' + bres.cand + '，' + blkLen + ' 字）');
          answer = String(bres.text).replace(/^\s+/, '');
          diag = '（结构法 ' + bres.blocks + ' 块取第 ' + (bres.idx + 1) + ' 块·' + blkLen + '字（新块 ' + (bres.nb === undefined ? '?' : bres.nb) + '/' + bres.blocks + '·分界线 ' + CP + '）';
        } else if (blkLen > 0) {
          diag = '（结构法只拿到 ' + blkLen + ' 字、尾部切片 ' + slcLen + ' 字 ⇒ 两边都不像正文，请人工看一眼那个窗口）';
          if (blkLen > slcLen) answer = String(bres.text).replace(/^\s+/, '');
        } else {
          diag = '（结构法没取到；尾部切片 ' + slcLen + ' 字；容器候选 ' +
            (((bres && bres.cands) || []).join(' / ') || '一个都没有') + '）';
        }
      } catch (e) { diag = '（结构法异常 ' + String((e && e.message) || e).slice(0, 50) + '，已退回尾部切片）'; }
      // ---------- 正文提取 C（v3.13 兜底）：从**我问话的最后一次回声**切到底 ----------
      // 为什么还要这一刀：站点改版时"结构法挑错容器 + 尾部切片切到工具条"会同时发生，实测豆包回了一整屏**侧栏历史标题**
      // （"自我复盘/学英语/炒股…"，427 字）。回声之后通常是回答，切出来的东西至少带上下文，比菜单墙有用。
      // 判据与 BLOCKS_SRC 的 lookMenu 保持一致：没有句末标点 + 平均行长 ≤16 ⇒ 菜单/列表，不是回答。
      // 用平均行长而不是"逐行 ≤12 字"，是为了不误杀代码、列表这类正常回答（实测豆包菜单每行 13~16 字）。
      function menuWall(s) {
        var str = String(s || '');
        if (str.length < 40 || /[,，。！？；;]/.test(str)) return false;
        var lines = str.split('\n'), n = 0, sum = 0;
        for (var i = 0; i < lines.length; i++) { var t = lines[i].trim(); if (!t) continue; n++; sum += t.length; }
        return n >= 5 && sum / n <= 16;
      }
      // ★v3.30★ 把"消息悬浮菜单/工具条"的界面词抠掉。实测豆包（2026-09-26 17:5x）：正确答案（`好`）后面紧跟
      //   `全选 / 分享图片 / 复制链接 / 分享图片预览 / 分享对话` ⇒ 尾部切片切出来的"正文"就是这堆界面词（**15 字**）✗；
      //   而它太短 ⇒ 又骗过了下面 menuWall 的"≥40 字"门槛 ⇒ 一路当正文交回去（用户看到的就是"0 字/15 字界面词"）。
      var UIWORD = /^(全选|分享图片预览|分享图片|分享对话|复制链接|复制图片|复制代码|复制|下载图片|下载|重新生成|重新回答|再生成|生成中|编辑|删除|赞|踩|朗读|新工作任务|新对话|智能搜索|深度思考|停止生成|继续生成|展开|收起|回到顶部)$/;
      function stripUi(s) {
        return String(s || '').split('\n').map(function (x) { return x.trim(); })
          .filter(function (x) { return x && !UIWORD.test(x); }).join('\n').replace(/^\s+|\s+$/g, '');
      }
      answer = stripUi(answer);
      if ((menuWall(answer) || answer.replace(/\s+/g, '').length < 4) && full) {
        var qi2 = txt.lastIndexOf(full);
        if (qi2 >= 0) {
          var tail3 = txt.slice(qi2 + full.length).replace(/^\s+/, '');
          var t3 = tail3.split('\n').filter(function (x) { return x.trim(); });
          if (diag.indexOf('已弃用') < 0 && t3.length >= 2 && !menuWall(tail3)) {
            answer = stripUi(tail3);
            diag += '（尾部切片像菜单墙，已改用"回声之后"那一段）';
          } else if (diag.indexOf('已弃用') >= 0 && menuWall(answer)) {
            // 结构法取到的是菜单、尾部切片也是菜单 ⇒ 只剩"回声之后"这一条路。哪怕它还长，也比一屏菜单强
            // （实测通义首页：回声之前是侧栏/生图面板，回声之后才是回答区）。
            if (t3.length >= 2 && tail3.trim().length < answer.trim().length) {
              answer = tail3;
              diag += '（尾部切片与结构法都是菜单，已改用"回声之后"那一段）';
            }
          }
        }
      }
      if (menuWall(answer)) diag += '（⚠ 切出来的还是像页面的菜单/列表，不像回答 —— 请人工看一眼那个窗口）';
      // ---------- 正文提取 E（v3.17）：★"这段字发问前就在页面上"= 界面文字，不是回答★ ----------
      // 为什么必须有这一条（2026-09-23 体检实测，一刀解决三个站）：
      //   豆包回 118 字「今天 14:41 收到收到 … 你能做些什么？ 你叫什么名字？」（**会话侧栏**）、
      //   智谱回 75 字「AI画图 精选工具 一键生同款 重启对话」（**生图落地页**）、
      //   通义回 1749 字「PPT创作 专家模式 参考资料 …」（**创作面板**）——
      //   三个都是"发问前页面本来就有的字"，靠"像不像菜单"的形态判据都漏（通义那坨是空格分隔、**没有换行**，
      //   menuWall 要求 ≥5 行 ⇒ 一行就不算菜单）。
      //   而"发问前有没有"这件事是**事实**，不是形态猜测：页面只在没生成时才会一直长这样。
      //   判据用"去掉空白后的核心字"互含（渲染器换行方式会变，逐字比会假阴性）。
      var coreOf = function (s) { return String(s || '').replace(/\s+/g, ''); };
      function answerInBaseline(s) {
        var c = coreOf(s);
        if (c.length < 8) return false;
        if (coreOf(before).indexOf(c) >= 0) return true;
        // ⚠ "答案比快照长"这件事没法直接当证据：快照被截断时我们只知道**没截断的部分**，比它长的答案本来就该比不中。
        //   夹具实测（2026-09-23）：通义那 1749 字的垃圾撞上 2500 字的尾部窗口是**假阴性**，也就是"该拦的没拦住"。
        //   解法＝**锚点法**：尾部窗口的开头 60 字就是"这里被截断了"的哨兵 —— 找到了，就说明**该有的东西都在**，
        //   这份窗口对判定是权威的，答案的核心字必须整段出现在里面；找不到，就不敢下结论（宁可漏判，也不误杀真回答）。
        var wins = [String(a.before || '')];
        if (before && before !== a.before) wins.push(String(before));
        for (var wi = 0; wi < wins.length; wi++) {
          var w = wins[wi];
          var cw = coreOf(w);
          if (cw.length < 400) continue;
          var anchor = coreOf(w.slice(0, 60));
          if (anchor.length < 40) continue;
          if (cw.indexOf(anchor) >= 0 && cw.indexOf(c) >= 0) return true;
        }
        return false;
      }
      if (answerInBaseline(answer)) {
        diag += '（⚠ 取到的这段字**发问前页面上就有** ⇒ 判定为界面文字、已丢弃；' +
          '八成是"问话没真发出去"或那个网页版窗口停在落地页）';
        answer = '';
      }
      // 短回答也可能整段是界面文字（智谱那 75 字只有 11 行短行、带"！" ⇒ 形态判据放它过）
      if (answer && answer.trim().length <= 200) {
        var UIW = /重启对话|新建对话|新对话|历史记录|精选工具|一键生同款|AI画图|AI生图|参考资料|专家模式|PPT创作|创意海报|上传图片|附件|发送|登录|注册|会员|订阅|设置|反馈|帮助|隐私|协议|模板|广场|灵感|我的|首页|换一换|更多/;
        var as = answer.trim();
        if (UIW.test(as) && !/[？?]/.test(as)) {
          diag += '（⚠ 这段短文字全是站点界面词（无问句）⇒ 判定为界面文字、已丢弃）';
          answer = '';
        }
      }
      // ---------- 正文提取 D（v3.14）：把站点自带的"推荐追问"尾巴切掉 ----------
      // 实测豆包会在回答下面挂一排推荐问题（你能做些什么？/ 你叫什么名字？/ …），它们跟着正文一起被切进来。
      // 只要这些推荐语出现在**我这次问话之后**的位置，就说明后面都不是正文 ⇒ 从最早出现的那个切掉。
      (function () {
        var CHIPS = ['你能做些什么？', '你叫什么名字？', '你可以回答哪些领域的问题？', '你可以做什么？',
          '能否帮我生成一段文案？', '能否帮我翻译这句话？', '能否帮我生成一个故事？'];   // 末三条＝智谱的固定推荐语（2026-09-23 实测）
        var qpos = full ? txt.lastIndexOf(full) : -1;
        if (qpos < 0) return;
        var cut = -1;
        for (var i = 0; i < CHIPS.length; i++) {
          var p = answer.indexOf(CHIPS[i]);
          // ★2026-09-23 22:5x：阈值 200 → 20。实测豆包的推荐追问出现在**第 135 字**，老阈值直接放行 ⇒
          //   侧栏/推荐语跟着正文一起落盘（体检报告里那段 175 字就是"收到收到 + 一屏侧栏"）。
          //   这七句是站点固定话术，20 字以后出现就一定是"回答下面的推荐追问"，不是正文在复述。
          if (p >= 20 && (cut < 0 || p < cut)) cut = p;
        }
        if (cut > 0) { answer = answer.slice(0, cut).replace(/\s+$/, ''); diag += '（已切掉站点推荐追问 ' + (answer.length) + ' 字处往后）'; }
      })();
      // ---------- 正文提取 D4（2026-09-23 22:5x）：跨了多轮 ⇒ 从**最后一次回声**之后重切 ----------
      // 为什么：豆包的结构法会把"整段对话"当一个块取回来（实测：正确答案在第一行，后面跟着上一轮的问与答、
      //   侧栏导航、推荐追问，共 135 字）。判据用**事实**：同一段正文里出现 ≥2 次我这次问的原话 ⇒ 它跨了多轮，
      //   最后一次回声之后的才是这次的回答。（D 那道 chips 刀先切过一遍，这里再切一次是为了把"上一轮的问答"也扔掉。）
      (function () {
        if (!full) return;
        var cnt = 0, last = -1, q = answer.indexOf(full);
        while (q >= 0) { cnt++; last = q; q = answer.indexOf(full, q + full.length); }
        if (cnt < 2) return;
        var tail = answer.slice(last + full.length).replace(/^\s+/, '');
        if (tail.replace(/\s+/g, '').length >= 2) { diag += '（正文里有 ' + cnt + ' 次问话回声 ⇒ 已从最后一次回声之后重切）'; answer = tail; }
      })();
      // ---------- 正文提取 D3（2026-09-23 22:5x）：切掉 DeepSeek / 智谱的**思考草稿** ----------
      // 实测原文：DeepSeek「只回复四个字：收到收到 / 已思考（用时 1 秒）/ 我们需要回答用户…直接回复。/ 收到收到」，
      //   智谱「… / 思考结束 / 收到收到」——前半段是模型的思考过程，落盘给用户看只是噪声。
      // 判据：找到"思考结束"这类标记 → **标记那一行后面第一段**（到空行为止）就是思考草稿，扔掉；剩下的才是回答。
      //   只有一段时**不冒险**（宁可留着草稿，也不能把真回答切没）。
      (function () {
        var i = answer.search(/已思考（用时|思考结束|已深度思考|深度思考（用时/);
        if (i < 0) return;
        var tail = answer.slice(i).replace(/^[^\n]*\n?/, '');
        var parts = tail.split(/\n{2,}/);
        var rest = parts.slice(1).join('\n\n').replace(/^\s+/, '');
        if (rest.replace(/\s+/g, '').length >= 2) { diag += '（已切掉思考草稿）'; answer = rest; }
      })();
      // ---------- 正文提取 D2（2026-09-23 22:5x）：按"**整行就是界面词**"切掉站点侧栏/导航/页脚 ----------
      // 为什么用"整行相等"而不是"包含"：正文里出现"对话""更多"这种词太正常了，按包含切会误杀真回答。
      //   侧栏导航在 DOM 里就是**一行一个词**（实测豆包：对话 / 图像生成 / 视频生成 / 帮我写作 / PPT 生成 / … / 豆包 快速）。
      (function () {
        var CHROME = ['对话', '图像生成', '视频生成', '帮我写作', 'PPT 生成', '音乐生成', '解题答疑', 'AI 播客',
          '录音转写', 'AI 表格', '深入研究', '更多', '新对话', '重启对话', '历史记录', '豆包 快速', '快速',
          '内容由 AI 生成', 'AI 生成可能有误 请核实', 'AI 生成可能有误，请核实', 'ChatGLM', '换一换',
          // ★2026-09-30★ 通义（qianwen.com）会话页底部会挂一坨**首页模板区**（实测取回正文后面跟着
          //   「研究探索不息 / 近三年新能源车竞争格局与趋势研究 / … / 帮你完成复杂任务，并生成研究报告 / 研究 模板」）。
          //   这两行是那块区域的**固定标题**，拿它当分界线最稳（原来没有它们，通义回答后面总拖一串模板名）。
          '研究探索不息', '帮你完成复杂任务，并生成研究报告'];
        var ls = String(answer).split('\n'), keep = [];
        for (var i = 0; i < ls.length; i++) {
          var t = ls[i].trim();
          if (i > 0 && t && CHROME.indexOf(t) >= 0) { diag += '（已在第 ' + i + ' 行切掉站点界面词「' + t + '」）'; break; }
          keep.push(ls[i]);
        }
        answer = keep.join('\n').replace(/\s+$/, '');
      })();
      // ---------- 正文提取 D5（2026-09-30）：切掉"贴着正文的界面词行"和"尾部的推荐追问" ----------
      // 现场（智谱清言 2026-09-30 实测）正文其实很干净，可回包长这样 ——
      //   `ChatGLM / 思考结束 / 收到收到 / 如何进行通路测试？ / 通路测试需要哪些工具？ / 通路测试的步骤是什么？ / 和我`
      //   只有中间一行是回答，其余全是站点界面（品牌名 / 思考标记 / 推荐追问 chips / 用户名）。
      //   用户要的是"能直接用的回答"，不是"把窗口截图转成文字" ⇒ 按**行**收尾：
      //   ① 去掉首尾的界面词行（品牌名 / 思考标记 / 用户名 / 操作按钮词 / 单字符）；
      //   ② 尾部连续 ≥2 行"短问句" = 推荐追问 ⇒ 从第一行起整段切掉；
      //   ③ 切完还剩内容才算数（绝不能把回答本身切没了 —— 所以每一步都验证剩余字数）。
      (function () {
        var UI = ['思考结束', '深度思考', '思考中', '和我', '分享', '复制', '重新生成', '停止生成', '停止回答',
          '点赞', '点踩', '反馈', '引用', '编辑', '删除', '赞同', '不赞同', '展开', '收起', '查看更多',
          '继续追问', '换个话题', '重新回答', '新建对话', '开启新对话', '输入你的问题', '发送', '联网搜索',
          'ChatGLM', 'DeepSeek', '豆包', '千问', '通义千问', '智谱清言', 'Kimi'];
        var isUI = function (s) {
          var t = String(s).trim();
          if (!t) return true;
          if (UI.indexOf(t) >= 0) return true;
          return t.replace(/\s+/g, '').length <= 1;      // 单个字符（头像字母之类）
        };
        var trimUI = function (a) {
          var i = 0, j = a.length - 1;
          while (i <= j && isUI(a[i])) i++;
          while (j >= i && isUI(a[j])) j--;
          return a.slice(i, j + 1);
        };
        var ls = trimUI(String(answer).split('\n'));
        var isQ = function (s) { var t = String(s).trim(); return t.length >= 2 && t.length <= 26 && /[？?]$/.test(t); };
        var cut = ls.length;
        while (cut > 0 && isQ(ls[cut - 1])) cut--;
        if (ls.length - cut >= 2) { diag += '（切掉尾部 ' + (ls.length - cut) + ' 行推荐追问）'; ls = ls.slice(0, cut); }
        ls = trimUI(ls);
        var out = ls.join('\n').replace(/\s+$/, '');
        if (out.replace(/\s+/g, '').length >= 2 && out !== answer) answer = out;
      })();
      var hint = (function (s) {
        var pats = [[/(聊天的人太多|排队|优先队列|繁忙|稍后再试|too many)/i, '站点在排队/限流'],
          [/(请先?登录|登录后|未登录|扫码登录|sign in to|log in to)/i, '可能要登录'],
          [/(验证码|安全验证|verify|captcha|滑块)/i, '可能要过验证码'],
          [/(额度|次数已用完|升级会员|开通会员|订阅会员)/i, '可能额度/会员限制']];
        for (var i = 0; i < pats.length; i++) if (pats[i][0].test(s)) return pats[i][1];
        return '';
      })(answer.slice(-1200) + ' ' + txt.slice(-1200));
      // 正文太单薄 = 大概率"没答完 / 没发出去"：把页面尾部原样带回来，别让人对着空回答猜（实测靠这条才看清 90000 这类脏字）
      // ★2026-09-30★ 还要"页面仍在忙 / 压根没开始回答"才算数：原来只看字数 <12，于是智谱那种**合法的超短回答**
      //   （「收到收到」4 字）也被扣上一大段"页面尾部原样：…"的噪音 —— 用户要的是能直接用的回答。
      var weak = answer.replace(/\s+/g, '').length < 12 && (busy || !started);
      // 说明：原来这里还有一条 `if (sendWarn)` 的支线，专门把"文字进了框但没按出去"的页面尾部带回来。
      // v3.17 起"没发出去"已经在发送那一步**当场逐级补救、还不行就直接报错**（throw），走不到这里了 ⇒ 删掉死代码，
      //   免得留着 `sendWarn` 这个已经不存在、看着像还能用的变量名去误导下一个人。
      if (!started) note0 = '\n\n[[webai-note:没看到它开始回答（可能没发出去、或页面还没响应）' + (hint ? '；' + hint : '') + ']]';
      else if (timedOut) note0 = '\n\n[[webai-note:等到超时，回答可能还没写完' + (hint ? '；' + hint : '') + ']]';
      else if (weak) note0 = '\n\n[[webai-note:正文只有 ' + answer.replace(/\s+/g, '').length + ' 字，像是没答完；页面尾部原样：' +
        txt.slice(-320).replace(/[\[\]]/g, '') + ']]';

      // ---------- 图片：新出现的优先；明确要图时退回"页面里最大的那张"；都没有就再等 ----------
      step = 'img';
      // 现场证据（v3.12）：把"选中了哪个输入框 / 正文是用哪种方法切出来的"带回脚本侧。
      // 没有这一行，调切取就只能靠猜；CLI 会把它当"诊断"打到 stderr（不进落盘正文）。
      var boxStr = (a.boxInfo && a.boxInfo.length) ? a.boxInfo[0] : (a.where || '?');
      // 页面坐标（v3.17）：多窗口 + 站点改版双重作用下，"这页到底在哪"经常是根因
      // （实测 2026-09-23：通义取回 1749 字 PPT 面板文案、智谱取回"AI画图/精选工具" ⇒ 判断它们在落地页不在会话页）。
      // 光看正文形态只能猜，把 URL/标题带回来就能一眼定案。
      var pageStr = '';
      try {
        var u0 = String(wv.getURL() || '').replace(/^https?:\/\//, '').slice(0, 46);
        var t0p = String(wv.getTitle() || '').replace(/[\[\]\n]/g, ' ').slice(0, 24);
        pageStr = '；页 ' + u0 + (t0p ? '「' + t0p + '」' : '');
      } catch (e) { }
      // 把**这次问的原话**也带回去（v3.17）：多个窗口时，日志里能一眼看出"这条回答是谁给的"。
      // 分屏/分离窗口各有一份桥，旧的那份不刷新就会按老逻辑抢答 —— 见 main.js 的 webai:claim。
      var pickNote = '\n\n[[webai-pick:选中输入框 ' + String(boxStr).replace(/[\[\]]/g, '') +
        '（共 ' + (a.nBox || 0) + ' 个候选）；正文 ' + (answer.length) + ' 字' + diag + pageStr +
        '；问「' + String(askText || '').replace(/[\[\]\n]/g, ' ').slice(0, 18) + '」]]';
      var note = note0 + pickNote;
      try {
        var list = asImgs(lastImgs);
        if (!list.length) { try { list = asImgs(await wv.executeJavaScript(imgSrc, true)); } catch (e) { list = []; } }
        var pick = function (arr) {
          return arr.filter(function (i) { return !i.video && i.w > 0 && i.h > 0; })
            .sort(function (x, y) { return (y.w * y.h) - (x.w * x.h); })[0] || null;
        };
        var fresh = list.filter(function (i) { return beforeImgs.indexOf(i.src) < 0; });
        var best = pick(fresh) || (wantImg ? pick(list) : null);
        // 要图但还没出现真图 ⇒ 再等最多 60 秒（豆包先插占位骨架，真图晚几百毫秒到几十秒）
        if (!best && wantImg) {
          var wi = Date.now();
          say('要图：还没看到真图，最多再等 60s…');
          while (Date.now() - wi < 60000) {
            await sleep(1500);
            try { list = asImgs(await wv.executeJavaScript(imgSrc, true)); } catch (e) { }
            fresh = list.filter(function (i) { return beforeImgs.indexOf(i.src) < 0; });
            best = pick(fresh) || pick(list);
            if (best) break;
          }
        }
        if (best) {
          var got = await grab(wv, best.src);
          var big = !!(got && got.ok && String(got.data || '').length > MAX_B64);
          var metaJson = JSON.stringify({
            ts: Date.now(), key: key, w: best.w, h: best.h,
            type: (got && got.type) || 'image/png', bytes: (got && got.size) || 0,
            fresh: fresh.length > 0, shot: !!got.shot, big: big, src: String(best.src).slice(0, 600)
          });
          if (got.ok && !big) {
            var w1 = await K.file.write(SPOOL_B64, got.data);
            var w2 = await K.file.write(SPOOL_JSON, metaJson);
            if (!(w1 && w1.ok === false) && !(w2 && w2.ok === false)) {
              S.lastAsset = { w: best.w, h: best.h, type: got.type, bytes: got.size, shot: !!got.shot };
              note = note0 + '\n\n[[webai-img:' + best.w + 'x' + best.h + ':' + got.type + ':' + SPOOL_B64 +
                (got.shot ? ':shot' : '') + ']]';
              say('取到图 ' + best.w + 'x' + best.h + ' ' + Math.round(got.size / 1024) + 'KB' + (got.shot ? '（截屏保底）' : '') + ' → 中转文件');
            } else {
              // 写盘失败：把主进程给的原话带回去（以前这里只写"写不进去"，排查全靠猜）
              note = note0 + '\n\n[[webai-img-err:中转文件写不进去 ' +
                String(JSON.stringify(w1 && w1.err ? w1.err : (w2 && w2.err) || w1 || w2)).replace(/[\[\]]/g, '').slice(0, 160) + ']]';
            }
          } else if (got.ok && big) {
            // 原图太大（>3.5MB）塞不进中转文件的文本上限：只落一份 meta（含签名直链），
            // 会话侧（Node，没有 CORS）会照直链把原图下下来 —— 实测 2304x1728/3.9MB 一次成功。
            var w3 = await K.file.write(SPOOL_JSON, metaJson);
            if (w3 && w3.ok === false) {
              note = note0 + '\n\n[[webai-img-err:原图太大(' + Math.round((got.size || 0) / 1024) + 'KB)且中转 meta 写不进去]]';
            } else {
              S.lastAsset = { w: best.w, h: best.h, type: got.type, bytes: got.size, big: true };
              note = note0 + '\n\n[[webai-img:' + best.w + 'x' + best.h + ':' + got.type + ':' + SPOOL_B64 + ':toobig]]';
              say('原图 ' + Math.round((got.size || 0) / 1024) + 'KB 超过中转上限，已把直链留给会话侧下载');
            }
          } else {
            note = note0 + '\n\n[[webai-img-err:' + String((got && got.err) || '抓图失败（fetch 和截屏都没成）').replace(/[\[\]]/g, '') + ']]';
          }
        } else if (wantImg) {
          // 把"到底看见了什么"带回去：没有这条信息，排查只能靠猜（踩过）
          var seen = list.map(function (i) { return (i.video ? '视频' : '图') + i.w + 'x' + i.h + ' ' + String(i.src).slice(0, 40); });
          note = note0 + '\n\n[[webai-img-err:这次没找到可取的图（页面共 ' + list.length + ' 个：' +
            String(seen.join(' ｜ ') || '一个都没有').replace(/[\[\]]/g, '').slice(0, 300) + '）]]';
        }
      } catch (e) { note = note0 + '\n\n[[webai-img-err:' + String((e && e.message) || e).replace(/[\[\]]/g, '') + ']]'; }

      S.last = { key: key, ok: true, chars: answer.length, ms: Date.now() - t0 };
      // 开头也放一枚版本戳：会话那头一眼就能看出"这次是谁在干活"（文本被截尾时也丢不了）
      return { ok: true, key: key, ver: S.ver, text: ('[[bridge:v' + S.ver + ']]\n' + answer + note).slice(-8000), busy: busy, elapsedMs: Date.now() - t0, empty: !answer };
    } catch (e) {
      S.last = { key: key, ok: false, err: String((e && e.message) || e), ms: Date.now() - t0 };
      return { ok: false, key: key, err: '[' + step + '] ' + String((e && e.message) || e), elapsedMs: Date.now() - t0 };
    }
  };

  // 串行队列：一次只伺候一个任务
  var chain = Promise.resolve();
  S.accept = function (task) {
    chain = chain.then(async function () {
      if (!task || !task.id) return;
      var mine = false;
      try { mine = await K.webai.claim(task.id); } catch (e) { mine = false; }
      if (!mine) return;                        // 别的窗口抢到了（多窗口时只有一个干活）
      S.busy = true;
      say('收到任务 ' + task.id + ' → ' + task.key + '（' + String(task.text || '').slice(0, 24) + '…）');
      try { S.lastDiag = ''; } catch (e) { }
      var out;
      try { out = await handle(task); }
      catch (e) { out = { ok: false, key: task.key, err: String((e && e.message) || e) }; }
      S.busy = false;
      try { await K.webai.done(task.id, out); } catch (e) { }
      say('任务 ' + task.id + ' 结束：' + (out.ok ? out.text.length + ' 字' : '失败 ' + out.err));
    }).catch(function (e) { S.busy = false; console.error('[webai-bridge] 队列异常', e); });
    return chain;
  };

  // 注册（preload 只有一个分发器，这里只是替换回调 ⇒ ⟳ 重跑不会叠监听）
  K.webai.onTask(function (t) { S.accept(t); });
  say('已就绪 v' + S.ver + '（**穿 shadow DOM** 取文+取图 / 等真图 / 截屏保底 / [[peek]] 只看不派；换手回调，旧闭包作废）');
  // 装载信标：⟳ 之后这个文件到底有没有被重新拉取并执行，看它就够了（排查全靠猜太费时间）
  try {
    K.file.write('<工作台>\\外壳\\data\\webai-bridge-beacon.txt',
      'v' + S.ver + ' loaded ' + new Date().toLocaleString() + '\n');
  } catch (e) { }
  // ★申报版本（v3.17）★：多窗口时主进程只把活派给"版本相等"的窗口。
  // 分屏/分离窗口里那份桥只在它自己那次加载/⟳ 时才更新，常常是旧代码 —— 旧桥的判正文逻辑是老的，
  // 抢到活就把正文切错（菜单墙/页脚/上一轮内容），现象像"刚改的判据坏了"，实测白查一整轮。
  // 有了申报，旧桥窗口根本不会被派活，而不是靠"抢单时才发现"。
  try {
    K.webai.bridge(S.ver).then(function (r) {
      if (r && r.ok === false) {
        console.warn('[webai-bridge] 这个窗口的桥是 v' + S.ver + '，主进程要 v' + r.want +
          ' ⇒ 不会再派活给它' + (r.isMain ? '' : '（场景窗口：点它的 ⟳ 或关掉重开）'));
      }
    }).catch(function () { });
  } catch (e) { }
})();
