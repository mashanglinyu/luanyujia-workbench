# 启动动画插件（dsh-plugin-boot-anim）v1.1.0

设置 → 启动动画：管理可选启动动画、选择当前动画、预览当前动画。**点卡片只切换，不预览；只有「▶ 预览当前」会播放。**

## 数据契约

| 文件 | 谁写 | 内容 |
|---|---|---|
| `<工作台>\外壳\data\boot-animation.json` | 本插件（选择）；外壳写 `available` | `{ id, available:[{id,name,desc}] }` |
| `<工作台>\外壳\data\boot-preview.json` | 本插件（预览） | `{ id, at, by }`；外壳每 1.2s 轮询，`at` 变大就播 `id` |

- `POST /plugins/boot-anim/select` `{id}`：只保存选择，**不写预览**。
- `POST /plugins/boot-anim/preview` `{id?}`：只写预览；`id` 省略=当前选择，**不改选择**。
- `GET /plugins/boot-anim/list`：当前选择 + 可选清单。

## 生效

- 选择：下次启动工作台生效。
- 预览：外壳轮询 `boot-preview.json`，1.2 秒内整窗播放；**预览不改变选择**。
- 改服务端路由需重启引擎；只改 `client/client.js` 刷新设置页即可。
