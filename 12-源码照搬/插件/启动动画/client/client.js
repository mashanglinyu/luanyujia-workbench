/**
 * 启动动画插件 —— 客户端（设置分区「启动动画」）。
 *
 * 静态手写 __ModuleLoader__ 格式（与其它插件一致，无需打包）。
 * 数据全部来自主机路由 /plugins/boot-anim/*；这里只负责画卡片 + 点选。
 *
 * 生效方式：选完写进 `外壳\data\boot-animation.json` ⇒ **下次启动工作台**生效
 *          （启动画面在引擎页面之前，所以不可能当场切；这是架构限制，不是没做）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-boot-anim',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    var react = require('react');
    var h = react.createElement;
    var useState = react.useState;
    var useEffect = react.useEffect;

    var API = '/plugins/boot-anim';
    var NS = 'boot-anim';

    var S = {
      wrap: { padding: '4px 2px 18px', fontSize: '14px', lineHeight: 1.6 },
      h1: { fontSize: '16px', fontWeight: 600, margin: '0 0 2px' },
      sub: { color: 'var(--dsw-alias-text-secondary, #8b93a1)', fontSize: '12.5px', marginBottom: '14px' },
      grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '10px' },
      card: {
        textAlign: 'left',
        padding: '12px 13px',
        borderRadius: '12px',
        border: '1px solid var(--dsw-alias-border-default, #2a2f3a)',
        background: 'var(--dsw-alias-bg-layer-2, #1b1e26)',
        color: 'inherit',
        cursor: 'pointer',
        transition: 'border-color 120ms ease, background 120ms ease, transform 120ms ease',
      },
      cardOn: {
        borderColor: 'var(--dsw-alias-state-business-primary, #4f8cff)',
        background: 'var(--dsw-alias-bg-layer-3, #232733)',
      },
      name: { fontSize: '13.5px', fontWeight: 600, marginBottom: '3px' },
      desc: { fontSize: '12px', color: 'var(--dsw-alias-text-secondary, #8b93a1)' },
      badge: { fontSize: '10.5px', padding: '0 6px', borderRadius: '999px', border: '1px solid currentColor', opacity: 0.85, marginLeft: '6px' },
      hint: { marginTop: '12px', fontSize: '12px', color: 'var(--dsw-alias-text-tertiary, #6b7383)' },
      err: { marginTop: '10px', fontSize: '12px', color: 'var(--dsw-alias-state-error-primary, #ff5d5d)' },
      top: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px', marginBottom: '12px' },
      btn: {
        flex: 'none', padding: '7px 12px', borderRadius: '9px', cursor: 'pointer',
        border: '1px solid var(--dsw-alias-state-business-primary, #4f8cff)',
        background: 'var(--dsw-alias-bg-layer-2, #1b1e26)',
        color: 'var(--dsw-alias-state-business-primary, #4f8cff)',
        fontSize: '12.5px', fontWeight: 600,
      },
      btnOff: { opacity: 0.5, cursor: 'default' },
    };

    function Section() {
      var _a = useState(null), data = _a[0], setData = _a[1];
      var _b = useState(''), saving = _b[0], setSaving = _b[1];
      var _c = useState(''), err = _c[0], setErr = _c[1];
      var _d = useState(false), previewing = _d[0], setPreviewing = _d[1];

      function load() {
        fetch(API + '/list', { cache: 'no-store' })
          .then(function (r) { return r.json(); })
          .then(function (j) { setData(j); })
          .catch(function (e) { setErr('读取失败：' + String(e && e.message || e)); });
      }
      useEffect(function () { load(); }, []);

      function pick(id) {
        if (saving) return;
        setSaving(id); setErr('');
        fetch(API + '/select', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: id }),
        })
          .then(function (r) { return r.json(); })
          .then(function (j) {
            setSaving('');
            if (!j || !j.ok) { setErr('切换失败：' + ((j && j.err) || '未知错误')); return; }
            setData(function (old) { return Object.assign({}, old, { current: j.current }); });
          })
          .catch(function (e) { setSaving(''); setErr('切换失败：' + String(e && e.message || e)); });
      }

      // 2026-10-22 宿主：预览只由「▶ 预览当前」触发；卡片点击只切换，不预览。
      // 服务端 /preview 只写 boot-preview.json，不改当前选择。
      function previewCurrent() {
        if (previewing || saving || !current) return;
        setPreviewing(true); setErr('');
        fetch(API + '/preview', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: current }),
        })
          .then(function (r) { return r.json(); })
          .then(function (j) {
            setPreviewing(false);
            if (!j || !j.ok) setErr('预览失败：' + ((j && j.err) || '未知错误'));
          })
          .catch(function (e) { setPreviewing(false); setErr('预览失败：' + String(e && e.message || e)); });
      }

      var list = (data && data.available) || [];
      var current = data && data.current;

      return h('div', { style: S.wrap },
        h('div', { style: S.top },
          h('div', null,
            h('div', { style: S.h1 }, '启动动画'),
            h('div', { style: Object.assign({}, S.sub, { marginBottom: 0 }) },
              '点卡片只切换（下次启动生效）；要现在看效果，点右上「▶ 预览当前」。')),
          h('button', {
            type: 'button',
            onClick: previewCurrent,
            disabled: previewing || !current || !!saving,
            style: Object.assign({}, S.btn, (previewing || !current || !!saving) ? S.btnOff : null),
            title: '把 boot-preview.json 写给外壳，立即整窗播放当前动画（不改配置）',
          }, previewing ? '▶ 预览中…' : '▶ 预览当前'),
        ),
        h('div', { style: S.grid },
          list.map(function (it) {
            var on = it.id === current;
            return h('button', {
              key: it.id,
              type: 'button',
              onClick: function () { pick(it.id); },
              style: Object.assign({}, S.card, on ? S.cardOn : null),
              title: it.desc || '',
            },
              h('div', { style: S.name },
                it.name || it.id,
                on ? h('span', { style: S.badge }, '使用中') : null,
                saving === it.id ? h('span', { style: S.badge }, '保存中…') : null),
              h('div', { style: S.desc }, it.desc || ''),
            );
          }),
        ),
        h('div', { style: S.hint },
          '配置：' + ((data && data.source) || '外壳\\data\\boot-animation.json')),
        data && data.fallback ? h('div', { style: S.err }, '外壳还没写出现清单，暂时只有默认项（' + data.fallback + '）') : null,
        err ? h('div', { style: S.err }, err) : null,
      );
    }

    exports.name = NS + '-client';
    exports.inject = ['slots'];
    exports.apply = function (ctx) {
      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register(
          { name: 'settings.section', id: 'my-plugins-boot-anim', order: 62, label: function () { return '启动动画'; } },
          Section,
        );
      });
    };
    return module.exports;
  },
});
