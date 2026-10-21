# 07 · 顶栏与菜单栏 —— 场景标签栏的源码

> 工作台顶上一排图标 = **场景标签栏**（点它切场景）。这一节放的是它的**真实源码**，三段分工不同：
>
> | 文件 | 摘自 | 管什么 | 改完怎么生效 |
> |---|---|---|---|
> | [1-建标签（外壳侧）.js](1-建标签（外壳侧）.js) | `renderer.js` | 建 DOM、钉会话、图标、⧉ 新窗口打开 | ⚠ **必须重启 GUI** |
> | [2-标签交互（热更新侧）.js](2-标签交互（热更新侧）.js) | `renderers.js` | 拖拽换位、未激活收成图标、固定组 | ⟳ 热加载即可 |
> | [tabbar.css](tabbar.css) | `styles.css` | 标签本体 / 激活态 / 收起态 / 拖拽态 | ⟳ 热加载 |

> 为什么刻意分成两侧：**外壳侧改一次要重启**（体验差），所以把"手感类"的东西（拖拽、收起、动画）全放到
> `renderers.js` 这一侧 —— 调手感不用重启。这是这套壳里最值得抄的一个**架构决定**，详细理由见
> [`../04-工作台搭建/`](../04-工作台搭建/)。

---

## 数据流（一句话版）

```
scenarios\*.json  ──► 外壳 renderer.js 建 <nav> + <button class="tab">
                            │（建完调一次）
                            ▼
              renderers.js  initScenarioTabBar({ nav, persist, pinnedIds })
                            │
                            ├─ 指针事件 → tabDropIndex() 算出落点
                            ├─ 固定组  → tabClampTarget() 卡住边界
                            ├─ FLIP    → flipNav() 让其它标签"让位"
                            └─ 顺序只报给外壳（外壳交主进程存）← 单一权威
```

**单一权威**这条是关键：交互层**自己不存顺序**，只把新顺序报给外壳；外壳交给主进程持久化。
两份顺序同时存 = 迟早打架，重启后还会"复位"。

---

## 三个真会出事的地方（源码里都有对应处理）

### 1. 用了 HTML5 拖放 ⇒ 拖动会**顺手切场景**

```js
// ① 用指针事件 + setPointerCapture，不用 HTML5 DnD；
// ② 拖动超过阈值 ⇒ 这一次的 click 在 capture 阶段就被吞掉 ⇒ 拖标签绝不会误切场景
```

HTML5 DnD 的 `dragstart` 和 `click` 会抢事件，而且幽灵图丑、落点时机不可控。
**判据**：拖完标签，场景没被切走 —— 才算对。

### 2. 固定组被拖动打乱

```js
function tabClampTarget(target, dragIsPinned, fixedCount) {
  if (dragIsPinned) return Math.min(target, fixedCount);   // 固定标签只能在自己组内换
  return Math.max(target, fixedCount);                     // 别的标签插不到固定组前面
}
```
`tabClampTarget` 和 `tabDropIndex` 都是**纯函数**（只吃数字），可以脱开浏览器直接单测 —— 这是它俩被单独拆出来的原因。

### 3. 重复初始化 ⇒ 监听器叠加

```js
if (nav.getAttribute('data-tabbar') === TABBAR_VERSION) { ... }   // 幂等：⟳ 只重排状态
nav.setAttribute('data-tabbar', TABBAR_VERSION);
```
热加载会反复调用同一个 `init`；没有幂等标记，监听器会一层层叠加，表现为"拖一下跳好几下"。

---

## 怎么接进你自己的壳（五步）

1. 建一个 `<nav class="tabs">`，每个场景一个 `<button class="tab">`（结构见 `1-建标签`）；
2. 给可拖动的标签加 `data-movable="1"`（只影响光标样式，**不要**设 `draggable`）；
3. 把 `2-标签交互` 里的 `initScenarioTabBar` 原样拷进你的热更新层；
4. 建完后调一次：`initScenarioTabBar({ nav, persist, pinnedIds })`
   - `persist(order)` —— 你的持久化回调（**只在这一个地方存顺序**）
   - `pinnedIds` —— 固定组（对应场景 json 的 `"first": true`）
5. 把 `tabbar.css` 并进样式表（注意它依赖 `--accent` 等主题变量）。

---

## 顺带说两个"看得见但容易漏"的细节

| 细节 | 为什么 |
|---|---|
| 未激活标签**收成图标**（`.tab-collapsed`） | 场景一多，标题全展开会挤成一排小字；收起后 33px 一个，能放 10+ 个 |
| 标签右侧 `⧉` = 在新窗口单独打开该场景 | 多屏时一屏一个场景；点它只开窗、**不切标签**（`ev.stopPropagation()`） |

---

> ⚠ 这三段是**摘录**（`renderer.js` 1222 行里的 1062–1200、`renderers.js` 17250 行里的 12638–12982、`styles.css` 的 242–353 + 3770–3774），
> 脱离宿主不能直接运行：`mkEl`、`window.app.*`（外壳注入的桥）、`ICONS` 都来自各自的上下文。看**结构和判据**，不要整段拷进别的项目。
