# 外壳 · 最小可运行工作台（体验版 v0.1）

> 这是一个**能直接跑起来**的 Electron 小壳：三个场景 + 顶栏片段 + 文件预览 + 盘容量。
> 不是你的完整工作台（没有 DSH 对话、没有 MCP、没有快照回退），但**不用装别的东西**，`npm install && npm start` 就能看到效果。

---

## 一、启动（3 步）

```powershell
cd 外壳
npm install          # 第一次要下载 Electron（约 100 MB，慢就换镜像）
npm start            # 或：npx electron .
```

想先确认"装没装坏"，跑自检（会截图到 `selftest.png` 然后退出）：

```powershell
npm run selftest
```

> 没装 Node？先装 Node 18+（含 npm）。⛔ 不要用别人的 `node_modules` 直接拷，版本不一致会白屏。

---

## 一·补、默认界面 = DeepSeek Harness 原始界面

启动后默认就是**引擎的对话界面**（就是 `dsh web` 那个页面），不是场景网格；点上面的「工作台」页签随时回到它。

引擎需要 token（`dsh web` 启动时会打印 `http://127.0.0.1:3080/?token=xxxx`）：

1. 把地址填进 `config.json` 的 `engineUrl`，token 填 `engineToken`；
2. 或者在 `config.local.json` 里写（**本机配置，不进库**，已在 .gitignore）；
3. 引擎重启后 token 会变，重填一次即可。

没填 token 会看到「引擎没启动/地址不对」的提示 —— 那是 401，不是程序坏了。

## 二、它能做什么 / 不能做什么

| 能 | 不能 |
|---|---|
| 三场景标签切换（自我复盘 / 本地电脑 / 设计杂活） | ❌ 内嵌真实 DSH 对话（AI 面板是占位） |
| 网格面板按 json 里的 col/row/w/h 摆放 | ❌ MCP 工具调用 |
| 文件树浏览 + 点击预览（文本/图片/视频/PDF/HTML） | ❌ 自动建会话（要你在引擎里建好后回填 id） |
| 磁盘分区卡（读真实容量，红黄绿） | ❌ 磁盘大户排行 / 可清理体检（需扫描接口） |
| 顶栏：品牌 · 5 个网页按钮 · 负载胶囊 · ⟳ · ⋯ · 窗口按钮 | ❌ 余额（本壳不接密钥） |
| 内置网页面板（DeepSeek 等，独立登录分区） | ❌ 快照回退（显示"未接入"） |
| ⋯ 菜单里「初始化记忆模板」→ 写进你的场景记忆目录 | ❌ 自动记忆机制（只给模板） |

---

## 三、目录

```
外壳/
├── main.js            主进程：窗口、IPC（读文件/列目录/盘容量/记忆注入）
├── preload.js         只暴露必要能力（contextIsolation 开着）
├── package.json       启动脚本 + Electron 依赖
├── renderer/
│   ├── index.html     顶栏 + 场景条 + 网格
│   ├── app.js         读 scenes/*.json、渲染面板、顶栏交互
│   └── style.css      深色/浅色
├── scenarios/         三个场景配置（自带的，改这里就能改布局）
└── 记忆模板/           三份 §〇 模板（⋯ 菜单里可注入）
```

---

## 四、常见问题

| 现象 | 原因 / 处理 |
|---|---|
| `npm start` 报 Electron 下载失败 | 换镜像：`npm config set registry https://registry.npmmirror.com` 后重走 |
| 窗口白屏 | 先 `npm run selftest` 看截图；再看控制台报错（主进程日志） |
| 文件面板显示 `C:\` | 场景 json 里 `root` 还是占位符 —— 改成你的真实目录 |
| AI 面板是白字占位 | 正常：本壳不内嵌对话，接法见 `../README.md`「AI 面板怎么接」 |
| 想改品牌名 | `renderer/index.html` 里 `.brand` 文本；改完关窗重开 |
| 想换场景图标 | 本壳用文字标签；要图标就在 `app.js` 的 `renderTab` 里加 `<img>` |
