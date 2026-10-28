/* public-clean.js —— 开源版：隐藏只属于「本机私有」的功能入口
 * 用法：index.html 末尾引入即可。
 * 说明：不是删除能力，只是开源模板里不展示（本地抠图、远程控制、模型提供方、本地模型）。
 */
(function () {
  var HIDE = ['#btn-remote', '#btn-models', '#btn-cut', '#btn-localmodel'];
  var TEXT_HIDE = ['远程控制', '手机远程访问', '本地抠图', '模型提供方', '记忆管理'];
  function css() {
    if (document.getElementById('public-clean-css')) return;
    var s = document.createElement('style');
    s.id = 'public-clean-css';
    s.textContent = HIDE.join(',') + '{display:none!important}';
    document.head.appendChild(s);
  }
  function sweep() {
    css();
    var items = document.querySelectorAll('.menu-item,.pop-item,.dd-item,button,a,li');
    for (var i = 0; i < items.length; i++) {
      var t = (items[i].textContent || '').trim();
      if (!t) continue;
      for (var k = 0; k < TEXT_HIDE.length; k++) {
        if (t === TEXT_HIDE[k] || t.indexOf(TEXT_HIDE[k]) === 0) { items[i].style.display = 'none'; break; }
      }
    }
  }
  function boot() { sweep(); setInterval(sweep, 1500); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
