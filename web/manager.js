// 后台页面：卡片管理、右键菜单、框选批量操作、拖进文件夹移动、卡片弹窗、样本详情面板、发送到工作流
import { createApp, reactive, computed, watch, onMounted } from './vue.esm-browser.prod.js';
import { get, post, del, coverUrl, sampleCover, snap, copyText, toast, confirmBox, pickFile, uploadCover, connectWS } from './core.js';
import { job, cancelJob, syncCivitai, syncMany, checkUpdates } from './civitai.js';
import { AliCard, AliMenu, CardModal, SamplePanel, AliTabs, AliGrid, AliIcon, AliProgress, vSortList } from './components.js';

const TABS = [{ k: 'model', n: '大模型' }, { k: 'lora', n: '风格LoRA' }, { k: 'sample', n: '样本' }];
const SORTS = [{ k: 'new', n: '最新' }, { k: 'name', n: '名称' }, { k: 'size', n: '大小' }, { k: 'custom', n: '自定义' }];

const menuFor = (kind, it) => {
  if (kind === 'sample') return [{ label: '使用样本', act: 'useSample' }, { sep: true }, { label: '删除样本', act: 'delSample', danger: true }];
  const send = [{ label: '发送到工作流（追加）', act: 'append' }, { label: '发送到工作流（替换）', act: 'replace' }];
  return [
    { label: '上传封面', act: 'upload' },
    ...(kind === 'lora' && it.triggers.length ? [{ label: '复制触发词', act: 'copy' }] : []),
    { sep: true }, ...send, { sep: true },
    { label: '刷新 CivitAI 数据', act: 'sync' }, { label: '检查更新', act: 'check' }, { sep: true },
    { label: it.exclude ? '取消排除' : '排除模型', act: it.exclude ? 'unexclude' : 'exclude' },
    { label: '删除模型', act: 'delete', danger: true },
  ];
};

// 框选后的批量菜单（n = 已选张数；black = 当前在黑名单页）
const multiMenu = (n, black) => [
  { label: `取消框选（已选 ${n} 张，Esc）`, act: 'cancel' }, { sep: true },
  { label: '发送到工作流（追加）', act: 'append' }, { label: '发送到工作流（替换）', act: 'replace' }, { sep: true },
  { label: '刷新 CivitAI 数据', act: 'sync' }, { sep: true },
  { label: black ? '取消排除' : '排除模型', act: black ? 'unexclude' : 'exclude' },
  { label: '删除模型', act: 'delete', danger: true },
];

const multiSampleMenu = (n) => [{ label: `取消框选（已选 ${n} 张，Esc）`, act: 'cancel' }, { sep: true }, { label: '删除样本', act: 'delSample', danger: true }];
const catMenu = [{ label: '重命名分类', act: 'catRename' }, { sep: true }, { label: '删除分类（样本搬回 Default）', act: 'catDelete', danger: true }];

const App = {
  components: { AliCard, AliMenu, CardModal, SamplePanel, AliTabs, AliGrid, AliIcon, AliProgress },
  directives: { focus: { mounted: (el) => el.focus() }, sortList: vSortList },
  setup() {
    const S = reactive({
      theme: document.documentElement.dataset.theme === 'light' ? 'light' : 'dark',
      tab: 'model', q: '', fam: '', sort: 'new', onlyFav: false, black: false, folder: '',
      items: { lora: [], model: [] }, tree: { lora: { total: 0, folders: [] }, model: { total: 0, folders: [] } },
      samples: [], live: {}, menu: null, modal: null, loading: false, order: {}, onlyUpdate: false, pop: null, sel: [],
      cats: [], cat: '', addCat: false, newCat: '', editCat: null,
    });

    // ── 数据 ──
    // tree 带 all=1：空文件夹也列出来（后台管理页需要；节点不带，只显示有模型的文件夹）
    const loadKind = async (k) => {
      const [items, tree] = await Promise.all([get('models?kind=' + k), get('tree?kind=' + k + '&all=1')]);
      S.items[k] = items; S.tree[k] = tree;
    };
    const loadSamples = async () => {
      const [smp, c] = await Promise.all([get('samples'), get('sample_cats')]);
      S.samples = smp; S.cats = c.cats || [];
      if (S.cat && !S.cats.includes(S.cat)) S.cat = '';
    };
    const loadAll = async () => {
      S.loading = true;
      try { await Promise.all([loadKind('lora'), loadKind('model'), loadSamples(), get('order').then((o) => { S.order = o; })]); }
      catch (e) { toast(e.message, 'err'); }
      S.loading = false;
    };
    const upsert = (item, oldId) => {
      const arr = S.items[item.kind]; if (!arr) return;
      const i = arr.findIndex((x) => x.id === (oldId || item.id));
      if (i >= 0) arr[i] = item; else arr.unshift(item);
    };
    const drop = (id) => { for (const k of ['lora', 'model']) S.items[k] = S.items[k].filter((x) => x.id !== id); };

    // ── 列表 ──
    const sorter = (k) => {
      const pos = new Map((S.order[S.tab] || []).map((id, i) => [id, i]));
      return {
        new: (x, y) => y.mtime - x.mtime, name: (x, y) => x.title.localeCompare(y.title, 'zh'), size: (x, y) => y.size - x.size,
        custom: (x, y) => { const a = pos.get(x.id) ?? 1e9, b = pos.get(y.id) ?? 1e9; return a !== b ? a - b : y.mtime - x.mtime; },
      }[k];
    };
    const vis = computed(() => (S.items[S.tab] || []).filter((i) => (S.black ? i.exclude : !i.exclude)));
    const fams = computed(() => [...new Set(vis.value.map((i) => i.badge))].sort());
    const blackCount = computed(() => (S.items[S.tab] || []).filter((i) => i.exclude).length);
    const favCount = computed(() => (S.items[S.tab] || []).filter((i) => i.favorite && !i.exclude).length);
    const updateCount = computed(() => (S.items[S.tab] || []).filter((i) => i.update && !i.exclude).length);
    const list = computed(() => {
      let a = vis.value;
      if (S.onlyFav) a = a.filter((i) => i.favorite);
      if (S.onlyUpdate) a = a.filter((i) => i.update);
      if (S.folder) a = a.filter((i) => i.folder === S.folder || i.folder.startsWith(S.folder + '/'));
      if (S.fam) a = a.filter((i) => i.badge === S.fam);
      const q = S.q.trim().toLowerCase();
      if (q) a = a.filter((i) => [i.title, i.version, i.file_name, i.base_model, i.notes, (i.triggers || []).join(' '), (i.tags || []).join(' ')].join(' ').toLowerCase().includes(q));
      return [...a].sort(sorter(S.sort));
    });
    const listIds = computed(() => list.value.map((i) => i.id));
    const selSet = computed(() => new Set(S.sel));
    const selItems = computed(() => (S.tab === 'sample' ? sampleList.value : list.value).filter((i) => selSet.value.has(i.id)));
    const sampleList = computed(() => S.samples.filter((s) => (!S.cat || s.category === S.cat) && (!S.q.trim() || s.name.toLowerCase().includes(S.q.trim().toLowerCase()))));
    const catCount = (c) => S.samples.filter((s) => s.category === c).length;
    const tree = computed(() => S.tree[S.tab] || { total: 0, folders: [] });
    const liveSet = computed(() => new Set(Object.values(S.live).flat()));
    const sortName = computed(() => SORTS.find((s) => s.k === S.sort).n);

    const setTab = (t) => { S.tab = t; S.folder = ''; S.fam = ''; S.black = false; S.onlyUpdate = false; S.menu = null; S.pop = null; S.sel = []; S.addCat = false; S.editCat = null; };
    watch(() => S.tab, (t) => { document.body.dataset.tab = t; }, { immediate: true });
    // 拖拽排序：被筛选掉的卡片位置不变，只重排当前看得到的这些，并保存为「自定义」顺序
    const onReorder = async (newIds) => {
      const k = S.tab, shown = new Set(newIds);
      const all = [...(S.items[k] || [])].sort(sorter('custom')).map((i) => i.id);
      let n = 0;
      S.order[k] = all.map((id) => (shown.has(id) ? newIds[n++] : id));
      S.sort = 'custom';
      try { await post('order', { kind: k, ids: S.order[k] }); } catch (e) { toast(e.message, 'err'); }
    };
    const cycleSort = () => { S.sort = SORTS[(SORTS.findIndex((s) => s.k === S.sort) + 1) % SORTS.length].k; };
    const toggleTheme = () => {
      const t = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
      const h = document.documentElement;
      h.classList.add('ali-theming'); h.dataset.theme = t; S.theme = t; setTimeout(() => h.classList.remove('ali-theming'), 500);
      try { localStorage.setItem('ali-theme', t); } catch {}
    };

    // ── 卡片操作 ──
    const patch = async (it, p) => { try { upsert(await post('meta', { id: it.id, patch: p })); } catch (e) { toast(e.message, 'err'); } };
    const openModal = (it, view = 'params') => { S.modal = { item: it, kind: it.kind, rev: 0, view }; };
    // 样本详情：点卡片在旁边弹出（无蒙版），再点同一张卡片收起；被选中的卡片显示「样本色」边框
    const popSample = computed(() => (S.pop ? S.samples.find((x) => x.id === S.pop.id) : null));
    const togglePop = (rect, smp) => { S.pop = S.pop && S.pop.id === smp.id ? null : { id: smp.id, rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom } }; };
    const onSampleSaved = (item) => { const i = S.samples.findIndex((x) => x.id === item.id); if (i >= 0) S.samples[i] = item; };
    const sendSample = async (smp) => {
      try { await post('send', { mode: 'useSample', kind: 'sample', sample: smp }); toast('已使用样本', 'ok'); S.pop = null; }
      catch (e) { toast(e.message, 'err'); }
    };
    const onSaved = (oldId, item) => {
      upsert(item, oldId);
      if (S.modal) S.modal = { item, kind: item.kind, rev: S.modal.rev + 1 };
      loadKind(item.kind).catch(() => {});  // 重命名后目录计数可能变化
    };
    const onMenu = (e, kind, it) => {
      if (S.sel.length && selSet.value.has(it.id)) return onBlankMenu({ x: e.clientX, y: e.clientY });
      S.sel = [];
      S.menu = { x: e.clientX, y: e.clientY, kind, it, items: menuFor(kind, it) };
    };
    const onBlankMenu = ({ x, y }) => {
      if (!selItems.value.length) return;
      S.menu = { x, y, kind: S.tab, multi: true, items: S.tab === 'sample' ? multiSampleMenu(selItems.value.length) : multiMenu(selItems.value.length, S.black) };
    };
    const onCatMenu = (e, c) => { S.menu = { x: e.clientX, y: e.clientY, kind: 'samplecat', cat: c, items: catMenu }; };
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && S.sel.length && !S.modal && !S.menu) S.sel = []; });

    const checkAll = () => checkUpdates(S.items[S.tab] || [], S.tab, upsert);   // 进度条和逐个请求都在 civitai.js

    // ── 框选后的批量操作（只处理当前看得到的、被选中的卡片）──
    const doMulti = async (act) => {
      S.menu = null;
      if (act === 'cancel') { S.sel = []; return; }
      const items = selItems.value, kind = S.tab;
      if (!items.length) return;
      try {
        if (act === 'delSample') {
          const names = items.slice(0, 5).map((it) => `「${it.name}」`).join('\n') + (items.length > 5 ? `\n…等共 ${items.length} 个` : '');
          if (!(await confirmBox({ title: `删除 ${items.length} 个样本`, danger: true, ok: '删除', body: `${names}\n\n样本的封面和保存的提示词会一起删除。` }))) return;
          for (const it of items) await del('samples?id=' + it.id);
          if (S.pop && items.some((it) => it.id === S.pop.id)) S.pop = null;
          await loadSamples(); toast(`已删除 ${items.length} 个样本`, 'ok');
        } else if (act === 'append' || act === 'replace') {
          await post('send', { mode: act, kind, items: items.map((it) => snap(it, kind === 'lora' ? { w: 1 } : { dtype: 'default' })) });
          toast(`已发送 ${items.length} 个到工作流`, 'ok');
        } else if (act === 'sync') {
          S.sel = [];   // 任务期间不要让选中状态挡着
          await syncMany(items, kind, upsert);
        } else if (act === 'exclude' || act === 'unexclude') {
          for (const it of items) upsert(await post('meta', { id: it.id, patch: { exclude: act === 'exclude' } }));
          toast(act === 'exclude' ? `已把 ${items.length} 个加入黑名单` : `已取消排除 ${items.length} 个`, 'ok');
        } else if (act === 'delete') {
          const names = items.slice(0, 5).map((it) => `「${it.title}」`).join('\n') + (items.length > 5 ? `\n…等共 ${items.length} 个` : '');
          const ok = await confirmBox({ title: `删除 ${items.length} 个模型`, danger: true, ok: '删除', body: `${names}\n\n将删除这些模型的模型文件、封面、元数据（有回收站支持时会进回收站）。` });
          if (!ok) return;
          let trash = true;
          for (const it of items) { const r = await post('delete', { id: it.id }); trash = trash && r.trash; drop(it.id); }
          loadKind(kind).catch(() => {});
          toast(trash ? `已把 ${items.length} 个移入回收站` : `已永久删除 ${items.length} 个`, 'ok');
        }
        S.sel = [];
      } catch (e) { toast(e.message, 'err'); }
    };
    // 把卡片拖到左边的文件夹上松手：单张 / 框选多张都一样；「全部」= 移到根目录
    const moveTo = async (ids, folder) => {
      if (S.tab === 'sample') {   // 样本：放进分类（拖到「全部」= 取消分类）
        const mv = ids.filter((id) => (S.samples.find((x) => x.id === id) || {}).category !== folder && S.samples.some((x) => x.id === id));
        if (!mv.length) return toast('已经在这个分类里了');
        try { await post('sample_move', { ids: mv, category: folder }); await loadSamples(); S.sel = []; toast(folder ? `已放进「${folder}」` : '已取消分类', 'ok'); }
        catch (e) { toast(e.message, 'err'); }
        return;
      }
      const k = S.tab, known = new Map((S.items[k] || []).map((i) => [i.id, i]));
      const mv = ids.filter((id) => known.has(id) && known.get(id).folder !== folder);
      if (!mv.length) return toast('已经在这个文件夹里了');
      try {
        const r = await post('move', { ids: mv, folder });
        for (const { old_id, item } of r.items) upsert(item, old_id);
        await Promise.all([loadKind(k), get('order').then((o) => { S.order = o; })]);
        if (r.items.length) toast(`已移动 ${r.items.length} 个到「${folder ? folder.split('/').pop() : '全部'}」`, 'ok');
        if (r.errors.length) toast(r.errors[0] + (r.errors.length > 1 ? `（另有 ${r.errors.length - 1} 个失败）` : ''), 'err');
        S.sel = [];
      } catch (e) { toast(e.message, 'err'); }
    };

    // 拖动分类调整顺序（节点里的标签顺序跟着变）
    const catSort = { item: '[data-sort]', axis: 'y', onSort: async (keys) => {
      S.cats = keys;
      try { await post('sample_cats', { action: 'reorder', names: keys }); } catch (e) { toast(e.message, 'err'); loadSamples(); }
    } };
    const startAddCat = () => { S.newCat = ''; S.addCat = true; };
    const addCat = async () => {
      const name = S.newCat.trim(); S.addCat = false;
      if (!name) return;
      try { await post('sample_cats', { action: 'add', name }); await loadSamples(); S.cat = name; toast(`已新建分类「${name}」`, 'ok'); } catch (e) { toast(e.message, 'err'); }
    };
    const renameCat = async () => {
      const ed = S.editCat; S.editCat = null;
      if (!ed || !ed.val.trim() || ed.val.trim() === ed.old) return;
      try { await post('sample_cats', { action: 'rename', name: ed.old, new_name: ed.val.trim() }); if (S.cat === ed.old) S.cat = ed.val.trim(); await loadSamples(); } catch (e) { toast(e.message, 'err'); }
    };
    const doCat = async (act) => {
      const c = S.menu.cat; S.menu = null;
      if (act === 'catRename') { S.editCat = { old: c, val: c }; return; }
      if (!(await confirmBox({ title: '删除分类', danger: true, ok: '删除', body: `「${c}」\n\n会删除这个分类的文件夹；里面的 ${catCount(c)} 个样本（连同封面）会搬回 Default 文件夹，不会被删除。` }))) return;
      try { await post('sample_cats', { action: 'delete', name: c }); if (S.cat === c) S.cat = ''; await loadSamples(); toast('分类已删除', 'ok'); } catch (e) { toast(e.message, 'err'); }
    };

    const doMenu = async (act) => {
      if (S.menu.kind === 'samplecat') return doCat(act);
      if (S.menu.multi) return doMulti(act);
      const { it, kind } = S.menu; S.menu = null;
      try {
        if (act === 'upload') { const f = await pickFile(); if (f) { upsert((await uploadCover(it.id, f)).item); toast('封面已更新', 'ok'); } }
        else if (act === 'copy') copyText(it.triggers.join(', '));
        else if (act === 'useSample') {
          await post('send', { mode: 'useSample', kind: 'sample', sample: it });
          toast('已使用样本', 'ok');
        }
        else if (act === 'append' || act === 'replace') {
          await post('send', { mode: act, kind, items: [snap(it, kind === 'lora' ? { w: 1 } : { dtype: 'default' })] });
          toast('已发送到工作流', 'ok');
        }
        else if (act === 'sync') { const n = await syncCivitai(it.id); if (n) upsert(n); }
        else if (act === 'check') {
          toast('正在检查更新…');
          const r = await post('check_update', { id: it.id });
          upsert(r.item);
          toast(r.has_update ? `有新版本：${r.latest.name}` : '已是最新版本', 'ok');
        }
        else if (act === 'exclude' || act === 'unexclude') { await patch(it, { exclude: act === 'exclude' }); toast(act === 'exclude' ? '已加入黑名单' : '已取消排除', 'ok'); }
        else if (act === 'delete') {
          const ok = await confirmBox({ title: '删除模型', danger: true, ok: '删除', body: `「${it.title}」\n\n将删除模型、封面、元数据 3 个文件（有回收站支持时会进回收站）。` });
          if (!ok) return;
          const r = await post('delete', { id: it.id });
          drop(it.id); loadKind(kind).catch(() => {});
          toast(r.trash ? '已移入回收站' : '已永久删除', 'ok');
        }
        else if (act === 'delSample') { await del('samples?id=' + it.id); if (S.pop && S.pop.id === it.id) S.pop = null; await loadSamples(); toast('样本已删除', 'ok'); }
      } catch (e) { toast(e.message, 'err'); }
    };

    onMounted(() => {
      loadAll();
      connectWS((type, data) => {
        if (type === 'alili.state') S.live[data.node_id] = data.ids || [];
        else if (type === 'alili.item') { if (data.removed) drop(data.removed); else upsert(data.item, data.old_id); }
        else if (type === 'alili.samples') loadSamples();
      });
    });

    return { S, TABS, SORTS, list, listIds, selSet, selItems, onReorder, fams, vis, tree, liveSet, blackCount, favCount, updateCount, checkAll, job, cancelJob, catCount, catSort, startAddCat, addCat, renameCat, onCatMenu, sampleList, sortName, setTab, cycleSort, toggleTheme, loadAll, loadSamples,
      openModal, onBlankMenu, moveTo, popSample, togglePop, onSampleSaved, sendSample, onSaved, onMenu, doMenu, patch, coverUrl, sampleCover, toast, pad: (p) => (p.split('/').length - 1) * 14 };
  },
  template: `
  <div class="ali-app">
    <div class="ali-aurora" aria-hidden="true"><i></i><i></i></div>

    <aside class="ali-panel ali-side">
      <div class="ali-brand">
        <img class="ali-logo" src="/alili/images/svg/logo.svg" alt="Alili">
        <div><h1 class="ali-title">模型管理器</h1><p class="ali-sub">by 阿里里</p></div>
      </div>
      <AliTabs :tabs="TABS" :model-value="S.tab" @update:model-value="setTab" />
      <div class="ali-tree-wrap">
        <ul v-if="S.tab !== 'sample'" class="ali-tree">
          <li data-drop="" :aria-current="String(S.folder === '')" @click="S.folder = ''">全部 <small>{{ tree.total }}</small></li>
          <li v-for="f in tree.folders" :key="f.path" :data-drop="f.path" :aria-current="String(S.folder === f.path)" :style="{ marginLeft: pad(f.path) + 'px' }" @click="S.folder = f.path">
            {{ f.path.split('/').pop() }} <small>{{ f.count }}</small>
          </li>
        </ul>
        <ul v-else class="ali-tree" v-sort-list="catSort">
          <li data-drop="" :aria-current="String(S.cat === '')" @click="S.cat = ''">全部 <small>{{ S.samples.length }}</small></li>
          <li v-for="c in S.cats" :key="c" :data-drop="c" :data-sort="c" :aria-current="String(S.cat === c)" @click="S.cat = c" @contextmenu.prevent="onCatMenu($event, c)">
            <input v-if="S.editCat && S.editCat.old === c" v-focus v-model="S.editCat.val" class="ali-input ali-cat-input" maxlength="24" @click.stop @keydown.enter="renameCat" @keydown.esc="S.editCat = null" @blur="renameCat">
            <template v-else>{{ c }} <small>{{ catCount(c) }}</small></template>
          </li>
          <li v-if="!S.cats.length" class="ali-hint" style="cursor:default">点下面「新增分类」建一个（会在 data 里新建同名文件夹），再把样本卡片拖进去</li>
        </ul>
      </div>
      <div v-if="S.tab === 'sample'" class="ali-side-foot">
        <input v-if="S.addCat" v-focus v-model="S.newCat" class="ali-input ali-cat-input" maxlength="24" placeholder="分类名称（会新建同名文件夹），回车确认" @keydown.enter="addCat" @keydown.esc="S.addCat = false" @blur="S.addCat = false">
        <button v-else class="ali-addcat" @click="startAddCat"><i></i>新增分类</button>
      </div>
    </aside>

    <main class="ali-panel ali-main">
      <div class="ali-main-head">
        <div class="ali-head-act">
          <button class="ali-btn ali-icon-btn" :title="S.theme === 'light' ? '切换到暗色' : '切换到亮色'" @click="toggleTheme"><AliIcon :name="S.theme === 'light' ? 'moon' : 'sun'" :fb="S.theme === 'light' ? '☾' : '☀'" /></button>
          <button class="ali-btn ali-icon-btn" title="系统设置" @click="toast('系统设置稍后提供')"><AliIcon name="settings" fb="⚙" /></button>
        </div>
      </div>
      <div class="ali-toolbar">
        <template v-if="S.tab !== 'sample'">
          <button class="ali-btn" @click="cycleSort">{{ sortName }} ▾</button>
          <button class="ali-btn" :class="{ 'is-on': S.onlyFav }" @click="S.onlyFav = !S.onlyFav">收藏 {{ favCount }}</button>
          <button class="ali-btn" :class="{ 'is-on': S.black }" @click="S.black = !S.black">黑名单 {{ blackCount }}</button>
          <button class="ali-btn" :class="{ 'is-on': S.onlyUpdate }" :disabled="!updateCount && !S.onlyUpdate" title="只看 CivitAI 上有新版本的模型" @click="S.onlyUpdate = !S.onlyUpdate">有更新 {{ updateCount }}</button>
          <button class="ali-btn" :disabled="job.running" title="向 CivitAI 查询所有已同步模型的最新版本" @click="checkAll">检查更新</button>
        </template>
        <button class="ali-btn" :disabled="S.loading" @click="loadAll">{{ S.loading ? '扫描中…' : '刷新' }}</button>
        <span v-if="selItems.length" class="ali-sel-tip">已框选 {{ selItems.length }} 张 · Esc 取消</span>
        <input class="ali-input" type="search" v-model="S.q" :placeholder="S.tab === 'sample' ? '搜索样本名称…' : '搜索名称、版本、触发词、备注…'">
      </div>

      <AliGrid v-if="S.tab !== 'sample'" :key="S.tab" :ids="listIds" sortable selectable :selected="S.sel" @reorder="onReorder" @select="S.sel = $event" @drop-folder="moveTo" @menu-blank="onBlankMenu">
        <AliCard v-for="(it, n) in list" :key="it.id" :index="n" :item="it" :cover="coverUrl(it)" :on="liveSet.has(it.id)" :fav="it.favorite" :sel="selSet.has(it.id)" editable
          @toggle="openModal(it)" @edit="openModal(it)" @versions="openModal(it, 'list')" @fav="patch(it, { favorite: !it.favorite })" @menu="onMenu($event, S.tab, it)" />
      </AliGrid>
      <AliGrid v-else :key="'sample'" :ids="[]" sortable drag-only selectable :selected="S.sel" @select="S.sel = $event" @drop-folder="moveTo" @menu-blank="onBlankMenu">
        <AliCard v-for="(s, n) in sampleList" :key="s.id" :index="n" :item="{ id: s.id, title: s.name, badge: '样本' }" :cover="sampleCover(s)"
          :on="!!S.pop && S.pop.id === s.id" :sel="selSet.has(s.id)" @toggle="togglePop($event, s)" @menu="onMenu($event, 'sample', s)" />
      </AliGrid>
      <div v-if="S.tab !== 'sample' && !list.length" class="ali-empty">{{ S.loading ? '正在扫描模型…' : S.black ? '黑名单是空的' : '没有找到模型，换个目录或搜索词试试' }}</div>
      <div v-if="S.tab === 'sample' && !sampleList.length" class="ali-empty">还没有样本。在工作流节点的卡片上右键「保存为样本」。</div>
    </main>

    <AliMenu v-if="S.menu" :x="S.menu.x" :y="S.menu.y" :items="S.menu.items" :kind="S.menu.kind" @pick="doMenu" @close="S.menu = null" />
    <CardModal v-if="S.modal" :key="S.modal.item.id + ':' + S.modal.rev" :item="S.modal.item" :kind="S.modal.kind" :view="S.modal.view" @close="S.modal = null" @saved="onSaved" @patched="upsert" />
    <AliProgress :job="job" @cancel="cancelJob" />
    <SamplePanel v-if="popSample" :key="popSample.id" :sample="popSample" :anchor="S.pop.rect" @close="S.pop = null" @saved="onSampleSaved" @send="sendSample" />
  </div>`,
};

createApp(App).mount('#app');
