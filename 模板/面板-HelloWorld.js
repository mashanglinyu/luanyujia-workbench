// 最简面板渲染器模板 —— 照抄改 3 处就能用：
//   ① 把 'hello' 换成你的类型名（建议带场景前缀，例：'site-hello'，避免和内置类型撞名）
//   ② 把渲染内容换成你要画的东西
//   ③ 到场景 json 里用 { "id": "xxx", "title": "xxx", "type": "hello", ... }
//
// 放哪儿：跟其它 renderers[...] 放同一个渲染器文件（文件末尾追加一段即可）。
// 怎么生效：保存后走「面板自刷新」通道重载面板 —— 不需要重启程序。
// 别忘了：图标一律内联 SVG（CDN 图标加载不出来就是空白框），布局用 flex/grid + min-width:0。

renderers['hello'] = function (body, meta, head) {
  // meta = 该面板在场景 json 里的那一段（原样，外加宿主注入的 scenario 字段）
  const line = document.createElement('div');
  line.textContent = meta.text || '还没写内容';
  body.appendChild(line);

  // 第三个参数 head = 标题栏元素：往里加按钮 / 状态小字
  const btn = document.createElement('button');
  btn.textContent = '换一句';
  btn.onclick = function () {
    line.textContent = '现在时间：' + new Date().toLocaleTimeString();
  };
  head.appendChild(btn);

  // 有异步内容（轮询 / 定时器 / 事件监听）时，返回一个清理函数：
  // 切场景或重建面板时宿主会调用它。不返回 = 定时器会在后台一直跑。
  const timer = setInterval(function () {
    // 轮询示例：这里可以刷新状态小字
  }, 60000);

  return function cleanup() {
    clearInterval(timer);
  };
};
