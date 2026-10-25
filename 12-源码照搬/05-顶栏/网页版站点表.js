/* ============================================================================
   05-顶栏/网页版站点表.js —— 顶栏那排「5 个网页端按钮」的数据表
   这是**真实配置**（照抄即可），不是示意：
   · url       = 打开哪个站点
   · partition = webview 的登录分区。**同一个分区 = 共用登录态**
   · userAgent = 换成纯 Chrome UA。DeepSeek 网页版认 Electron 会盖一层「使用环境异常」弹窗，
                 写 'chrome' 才能正常用（内核版本取当前 Electron 的，不写死）
   · noWarm    = 不预热（不常驻后台，点开才创建）
   · fallback  = 图标加载失败时显示的单字

   ★ 最要紧的一条：DeepSeek 这一项的分区固定写 `persist:embed-sr-site-bl`，
     和「自我复盘」场景里那个内嵌 DeepSeek 面板（面板 id = `sr-site-bl`，分区规则 = persist:embed-<面板id>）
     **是同一个分区** ⇒ 在场景面板里登录过，顶栏点开就是登录好的，反过来也一样。
     ⚠ 别改这个分区名，改了两边同时掉登录。
============================================================================ */

var WEB_AI = [
  {
    key: 'deepseek', name: 'DeepSeek', icon: 'assets/webai/deepseek.png', fallback: 'D',
    url: 'https://chat.deepseek.com/',
    partition: 'persist:embed-sr-site-bl',   // ← 与「自我复盘」面板共用登录态
    userAgent: 'chrome',
    noWarm: true,
    tip: '与自我复盘场景的 DeepSeek 面板共用登录态（同一个 webview 分区）'
  },
  { key: 'doubao',  name: '豆包',     icon: 'assets/webai/doubao.png',  fallback: '豆', url: 'https://www.doubao.com/chat/' },
  { key: 'tongyi',  name: '通义千问', icon: 'assets/webai/tongyi.png',  fallback: '通', url: 'https://tongyi.aliyun.com/qianwen/' },
  { key: 'chatglm', name: '智谱清言', icon: 'assets/webai/chatglm.png', fallback: '智', url: 'https://chatglm.cn/main/alltoolsdetail' },
  { key: 'kimi',    name: 'Kimi',     icon: 'assets/webai/kimi.png',    fallback: 'K',  url: 'https://www.kimi.com/' }
];

// 说明：不写 partition 的站点（豆包/通义/智谱/Kimi）＝各自默认分区，互不影响；
// 想省内存可以给它们也加上 noWarm: true。
// 图标就在本目录 assets/webai/ 下（5 张 180×180 PNG）。
