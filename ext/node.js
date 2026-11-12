// Alili模型管理器 —— 画布节点前端：卡片面板 + 与后台网页联动 + CLIP/VAE/步数联动
import { app } from '/scripts/app.js';
import { api } from '/scripts/api.js';
import * as Vue from '/alili/web/vue.esm-browser.prod.js';
import { AliCard, AliSwitch, AliMenu, CardModal, SamplePanel, ImagePicker, AliTabs, AliGrid, vSortList } from '/alili/web/components.js';
import { get, post, del, coverUrl, sampleCover, snap, copyText, toast, pickFile, uploadCover } from '/alili/web/core.js';

if (!document.getElementById('ali-css')) {
  document.head.append(Object.assign(document.createElement('link'), { id: 'ali-css', rel: 'stylesheet', href: '/alili/web/alili.css' }));
}

const nodes = new Set();   // 画布上所有 Alili 节点
const recent = [];         // 最近一次运行的输出图（用于「保存为封面 / 样本封面」）
let fresh = false;

// ───────────── CLIP / VAE / 步数 联动（统一的「找节点 → 改控件 → 对齐下拉真实名称」） ─────────────
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const clipMap = () => get('clip_map');  // 每次现取：改了 clip_map.json 不用刷新页面
const live = (pred) => allNodes().filter((n) => (n.mode ?? 0) === 0 && pred(n));  // 只要「启用」的节点：Mute / Bypass 的不动
const wid = (n, re) => n.widgets?.find((w) => re.test(w.name));

function allNodes() {  // 主画布 + 子图里的节点
  const out = [], seen = new Set();
  const walk = (g) => { if (!g || seen.has(g)) return; seen.add(g); for (const n of g._nodes || []) { out.push(n); walk(n.subgraph); } };
  walk(app.graph);
  return out;
}

const base = (x) => String(x).split(/[/\\]/).pop();
const stem = (x) => base(x).replace(/\.(safetensors|sft|ckpt|pt|pth|bin|gguf)$/i, '');

// 在下拉选项里找真正存在的那一项：完全相同 → 路径无关地相同 → 忽略扩展名相同 → 互相包含（取最像的）
function pickOption(opts, val) {
  if (opts.includes(val)) return val;
  const n = norm(val), nb = norm(base(val)), ns = norm(stem(val));
  const hit = opts.find((x) => norm(x) === n) ?? opts.find((x) => norm(base(x)) === nb) ?? opts.find((x) => norm(stem(x)) === ns);
  if (hit !== undefined) return hit;
  let best, score = 0;
  for (const x of opts) {
    const a = norm(stem(x));
    if (!a || !ns || (!a.includes(ns) && !ns.includes(a))) continue;
    const r = Math.min(a.length, ns.length) / Math.max(a.length, ns.length);
    if (r >= 0.5 && r > score) { best = x; score = r; }
  }
  return best;
}

// 改控件：对齐下拉真实名称；返回 {ok, value} 或 {ok:false, miss}
function setW(n, re, val) {
  const w = wid(n, re);
  if (!w || !val) return null;
  let v = val;
  const raw = w.options?.values;
  const opts = typeof raw === 'function' ? raw.call(w, w, n) : raw;
  if (Array.isArray(opts)) {
    v = pickOption(opts, val);
    if (v === undefined) return { ok: false, miss: val };
  }
  const old = w.value;
  w.value = v;
  n.onWidgetChanged?.(w.name, v, old, w);
  w.callback?.(v);
  n.has_errors = false;
  return { ok: true, value: v };
}

function pickNode(list, title) {  // 多个候选节点时弹小菜单让用户选
  if (list.length <= 1) return Promise.resolve(list[0] || null);
  return new Promise((resolve) => {
    const m = document.createElement('div');
    m.className = 'ali-menu is-open';
    m.style.cssText = `left:${innerWidth / 2 - 110}px;top:${innerHeight / 3}px`;
    const h = Object.assign(document.createElement('div'), { className: 'ali-hint', textContent: title });
    h.style.padding = '6px 12px'; m.append(h);
    const done = (n) => { m.remove(); removeEventListener('pointerdown', away, true); resolve(n); };
    const away = (e) => { if (!m.contains(e.target)) done(null); };
    list.forEach((n) => { const b = Object.assign(document.createElement('button'), { textContent: `${n.title || n.type}  #${n.id}` }); b.onclick = () => done(n); m.append(b); });
    document.body.append(m);
    setTimeout(() => addEventListener('pointerdown', away, true));
  });
}

// 家族 → 映射项：先精确，再忽略大小写 / 符号，最后用「路径 + 基础模型 + 文件名」模糊命中（长名字优先，Flux2 先于 Flux）
function confFor(map, t) {
  if (map[t.family]) return [t.family, map[t.family]];
  const keys = Object.keys(map).sort((a, b) => b.length - a.length);
  const k = keys.find((k) => norm(k) === norm(t.family)) || keys.find((k) => norm(`${t.name} ${t.base_model} ${t.file_name}`).includes(norm(k)));
  return k ? [k, map[k]] : [null, null];
}

// 单 CLIP / 双 CLIP 节点互相切换时，把下游的 CLIP 连线从「另一类」节点瞬间转移到当前节点上
function rewireClip(target, dual) {
  const g = target.graph, R1 = /^(clip_name1|clip_name|clip1)$/i, R2 = /^(clip_name2|clip2)$/i;
  const slotOf = (n) => Math.max(0, n.outputs?.findIndex((o) => o.type === 'CLIP' || o.name === 'CLIP') ?? 0);
  const getLink = (id) => (g.links?.get ? g.links.get(id) : g.links?.[id]);
  let moved = 0;
  for (const o of live((n) => n !== target && n.graph === g && wid(n, R1) && !!wid(n, R2) !== dual)) {
    const os = slotOf(o);
    for (const id of [...(o.outputs?.[os]?.links || [])]) {
      const link = getLink(id), down = link && g.getNodeById(link.target_id);
      if (!down) continue;
      o.disconnectOutput(os, down);
      target.connect(slotOf(target), down, link.target_slot);
      moved++;
    }
  }
  return moved;
}

async function linkModel(t) {
  const map = await clipMap();
  const [fam, conf] = confFor(map, t);
  const ok = [], bad = [];
  const note = (label, r, node) => { if (!r) return; r.ok ? ok.push(label) : bad.push(`${label}里没有「${r.miss}」`); if (!r.ok) console.warn(`[Alili] ${label}：节点 #${node.id} 的下拉里找不到 ${r.miss}`); };
  let seen = 0;

  // 大模型卡片本身就是模型加载器，不需要也不去改画布上其它的模型加载器；这里只联动 CLIP 和 VAE
  if (!conf) {
    return toast(`没有找到「${t.title}」对应的 CLIP / VAE 映射（家族：${t.family || '未识别'}），请在 clip_map.json 里添加`, 'err');
  } else {
    // ① CLIP：单 CLIP 找单节点，双 CLIP 找双节点
    const dual = !!conf.clip2;
    const R1 = /^(clip_name1|clip_name|clip1|clip)$/i, R2 = /^(clip_name2|clip2|clip_2)$/i;
    const clip = await pickNode(live((n) => wid(n, R1) && !!wid(n, R2) === dual), '选择要联动的 CLIP 加载器');
    if (clip) {
      seen++;
      note('CLIP', setW(clip, R1, conf.clip), clip);
      if (dual) note('CLIP2', setW(clip, R2, conf.clip2), clip);
      note('CLIP 类型', setW(clip, /^(type|类型)$/i, conf.type), clip);
      note('CLIP 设备', setW(clip, /^(device|设备)$/i, conf.device), clip);
      const moved = rewireClip(clip, dual);
      if (moved) ok.push(`已把 ${moved} 条 CLIP 连线转到 #${clip.id}`);
    }
    // ② VAE：视频 + 音频两个 VAE 时自动分发，否则单个直接填、多个让你选
    const VR = /^(vae_name|vae)$/i, vaes = live((n) => wid(n, VR));
    if (conf.vae2 && vaes.length === 2) {
      const audio = vaes.find((n) => /audio|音频|sound/i.test(`${n.title || ''} ${n.type || ''}`)) || vaes[1];
      const video = vaes.find((n) => n !== audio);
      seen += 2;
      note('视频 VAE', setW(video, VR, conf.vae), video); note('音频 VAE', setW(audio, VR, conf.vae2), audio);
    } else {
      const v = await pickNode(vaes, '选择要联动的 VAE 加载器');
      if (v) { seen++; note('VAE', setW(v, VR, conf.vae), v); }
    }
    if (!seen) return toast('画布上没有找到已启用的 CLIP / VAE 加载器节点（被 Mute 或 Bypass 的不会联动）', 'err');
  }
  app.graph.setDirtyCanvas(true, true);
  if (bad.length) toast(`联动${fam ? '（' + fam + '）' : ''}未完成：${bad.join('；')}${ok.length ? '（已完成：' + ok.join('、') + '）' : ''}`, 'err');
  else if (ok.length) toast(`已联动${fam ? '（' + fam + '）' : ''}：${ok.join('、')}`, 'ok');
}

function applySteps(picked) {  // 从 LoRA / 大模型名字里找 “4steps / 8-step”，找不到回到 20
  const pat = /(\d{1,2})\s*[-_ ]?\s*steps?\b/i;
  let steps = 25;
  for (const t of picked) { const m = pat.exec(`${t.title} ${t.version} ${t.file_name}`); if (m) { steps = +m[1]; break; } }
  live((n) => wid(n, /^(steps|步数)$/i)).forEach((n) => { const w = wid(n, /^(steps|步数)$/i); w.value = steps; w.callback?.(steps); });
  app.graph.setDirtyCanvas(true, true);
}

// ───────────── 每个节点一个 store ─────────────
function createStore(node, wState) {
  const s = Vue.reactive({
    tab: 'model', multi: { lora: false, model: false }, link: true, q: '', fam: '',
    tray: { lora: [], model: [] }, sel: { lora: [], model: [] },
    samples: [], cats: [], cat: '', menu: null, modal: null, pop: null, picker: null,
  });
  const find = (k, id) => s.tray[k].find((t) => t.id === id);
  const picked = (k) => s.tray[k].filter((t) => s.sel[k].includes(t.id));  // 按卡片顺序：拖动卡片 = 调整 LoRA 叠加顺序
  const sig = () => ({ m: [...s.sel.model], l: [...s.sel.lora] });
  let last = sig();

  // 写进隐藏的 state 控件：nodes.py 读 models / loras / multi，其余字段用于恢复界面
  const payload = () => JSON.stringify({
    v: 1, tab: s.tab, multi: s.multi, link: s.link, tray: s.tray, sel: s.sel,
    models: picked('model').map((t) => ({ key: t.key, name: t.name, dtype: t.dtype || 'default' })),
    loras: picked('lora').map((t) => ({ name: t.name, w: +t.w })),
  });

  let rt;
  const report = (now) => {  // 告诉后台网页：当前工作流里选中了哪些卡片
    clearTimeout(rt);
    const go = () => post('state', { node_id: node.id, ids: [...s.sel.model, ...s.sel.lora] }).catch(() => {});
    now ? go() : (rt = setTimeout(go, 300));
  };

  Vue.watch(payload, (p) => {
    wState.value = p;
    node.graph?.setDirtyCanvas?.(true, true);
    report();
    const cur = sig(), prev = last; last = cur;
    if (!s.link) return;
    const added = cur.m.filter((id) => !prev.m.includes(id)).pop();
    if (added) { const t = find('model', added); if (t) linkModel(t).catch((e) => { console.error('[Alili] 联动失败', e); toast('联动失败：' + e.message, 'err'); }); }
    if (JSON.stringify(cur) !== JSON.stringify(prev)) applySteps([...picked('lora'), ...picked('model')]);
  }, { flush: 'post' });

  Vue.watch(() => s.tab, () => { s.fam = ''; s.pop = null; });
  Vue.watch(() => [s.multi.lora, s.multi.model], () => {  // 关闭多选：只保留最后一个
    for (const k of ['lora', 'model']) if (!s.multi[k] && s.sel[k].length > 1) s.sel[k] = s.sel[k].slice(-1);
  });

  const loadSamples = async () => {
    try { const [smp, c] = await Promise.all([get('samples'), get('sample_cats')]); s.samples = smp; s.cats = c.cats || []; } catch {}
  };
  const refreshTray = async () => {  // 同步卡片最新的名字 / 封面等
    try {
      for (const k of ['lora', 'model']) {
        if (!s.tray[k].length) continue;
        const map = new Map((await get('models?kind=' + k)).map((i) => [i.id, i]));
        s.tray[k].forEach((t) => { const i = map.get(t.id); if (i) Object.assign(t, snap(i)); });
      }
    } catch {}
  };
  const load = () => {  // 打开工作流时恢复
    try {
      const o = JSON.parse(wState.value || '{}');
      if (o.v) {
        s.tab = o.tab || 'lora'; Object.assign(s.multi, o.multi || {}); s.link = o.link !== false;
        s.tray.lora = o.tray?.lora || []; s.tray.model = o.tray?.model || [];
        s.sel.lora = o.sel?.lora || []; s.sel.model = o.sel?.model || [];
      }
    } catch {}
    last = sig();  // 恢复不触发联动
    refreshTray(); loadSamples();
  };

  const toggle = (k, id) => {
    const a = s.sel[k];
    s.sel[k] = s.multi[k] ? (a.includes(id) ? a.filter((x) => x !== id) : [...a, id]) : (a.includes(id) ? [] : [id]);
  };
  const remove = (k, id) => { s.tray[k] = s.tray[k].filter((t) => t.id !== id); s.sel[k] = s.sel[k].filter((x) => x !== id); };
  const reorder = (k, shownIds) => {  // 只重排当前看得到的卡片，被筛选掉的位置不变
    const shown = new Set(shownIds); let n = 0;
    const byId = new Map(s.tray[k].map((t) => [t.id, t]));
    s.tray[k] = s.tray[k].map((t) => (shown.has(t.id) ? byId.get(shownIds[n++]) : t));
  };
  const select = (k, ids) => { s.sel[k] = s.multi[k] ? [...new Set([...s.sel[k], ...ids])] : ids.slice(-1); };

  const restore = (st) => {  // 样本 → 还原整套组合
    // 1. 保留节点原有的全部卡片，只把样本需要的模型补进托盘
    for (const m of st.models || []) {
      const t = find('model', m.id);
      if (t) Object.assign(t, m); else s.tray.model.push({ ...m });
    }
    // 2. 把样本需要的 LoRA 补进托盘并对齐权重
    for (const l of st.loras || []) {
      const t = find('lora', l.id);
      if (t) { Object.assign(t, l); if (l.w !== undefined) t.w = l.w; } else s.tray.lora.push({ ...l });
    }
    // 3. 自动选中样本里的模型和 LoRA（单选模式切为该模型，多选模式合并选中）
    select('model', (st.models || []).map((m) => m.id));
    select('lora', (st.loras || []).map((l) => l.id));

    s.tab = 'model';
    refreshTray();
  };
  const receive = (d) => {  // 后台网页「发送到工作流」
    if (d.kind === 'sample') return restore(d.sample.state);
    const k = d.kind;
    const items = d.items.map((x) => ({ ...x, ...(k === 'lora' ? { w: x.w ?? 1 } : { dtype: x.dtype || 'default' }) }));
    if (d.mode === 'replace') { s.tray[k] = []; s.sel[k] = []; }
    for (const it of items) { const t = find(k, it.id); if (t) Object.assign(t, it); else s.tray[k].push(it); }
    select(k, items.map((i) => i.id));
    s.tab = k;
  };
  const syncItem = (oldId, item) => {  // 编辑 / 重命名 / 换封面后更新卡片
    const k = item.kind, t = find(k, oldId);
    if (!t) return;
    Object.assign(t, snap(item));
    if (oldId !== item.id) s.sel[k] = s.sel[k].map((x) => (x === oldId ? item.id : x));
  };

  const saveCover = async (t) => {
    if (!recent.length) return toast('工作流还没有输出图，先运行一次再试', 'err');
    const img = recent.length === 1 ? recent[0] : await new Promise((res) => { s.picker = { images: [...recent].reverse(), res }; });
    if (!img) return;
    try { const r = await post('cover_from_output', { id: t.id, ...img }); syncItem(t.id, r.item); toast('封面已更新', 'ok'); }
    catch (e) { toast(e.message, 'err'); }
  };
  const saveSample = async () => {
    const models = picked('model'), loras = picked('lora');
    const img = recent[recent.length - 1];
    let graph = null;  // 当前画布（ComfyUI 历史记录为空时的兜底）
    try { graph = (await app.graphToPrompt()).output; } catch {}
    try {
      const r = await post('samples', {
        name: models.length ? [models[0].title, ...loras.map((l) => l.title)].join(' + ').slice(0, 60) : '工作流样本',
        state: { multi: { ...s.multi }, models: models.map((m) => ({ ...m })), loras: loras.map((l) => ({ ...l })) },
        output: img || null, cover_id: models[0]?.id, capture: true, prompt: graph,
      });
      await loadSamples();
      toast(r.captured ? '已保存到样本（已读取提示词和参数）' : '已保存到样本，但没读到提示词和参数：运行一次工作流后再保存，或在样本里手动填写', r.captured ? 'ok' : 'err');
    } catch (e) { toast(e.message, 'err'); }
  };

  return { s, node, load, report, toggle, remove, reorder, restore, receive, syncItem, saveCover, saveSample, loadSamples, find };
}

// ───────────── 「打开后台页面」按钮的位置 ─────────────
// 'title' = 节点标题栏右上角（画在画布上，经典画布模式可用）；'panel' = 面板里标签页右边的一个 DOM 按钮。
// 如果在你的 ComfyUI 版本里标题栏上没有出现按钮，把下面改成 'panel' 即可。
const MANAGER_BTN = 'title';
const EXT_ICON = new Path2D('M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5');
const openManagerPage = () => window.open('/Manager', '_blank');
const titleBtn = (node) => {   // 按钮在节点坐标里的位置（标题栏里，y 为负）
  const th = (window.LiteGraph && LiteGraph.NODE_TITLE_HEIGHT) || 30, z = 18;
  return { x: node.size[0] - z - 12, y: -th + (th - z) / 2, z };
};

// ───────────── 面板模板 ─────────────

const PANEL_TPL = `
<div class="ali-root ali-embed" :data-tab="s.tab" @contextmenu.prevent.stop @wheel="onWheel">
  <div class="ali-n-top" :class="{ 'no-chips': !chips }">
  <div class="ali-n-head">
    <div class="ali-n-l"><input class="ali-input" v-model="s.q" placeholder="搜索"></div>
    <AliTabs :tabs="TABS" v-model="s.tab" />
    <div class="ali-n-r"><button v-if="panelBtn" class="ali-btn ali-icon-btn ali-n-open" title="打开后台管理页面" @click="openManager"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg></button></div>
  </div>
  <div class="ali-n-bar">
    <div class="ali-n-l" :style="{ visibility: s.tab === 'sample' ? 'hidden' : 'visible' }"><AliSwitch v-model="s.multi[s.tab]" label="多选" /></div>
    <div class="ali-filters" v-sort-list="sortOpt"><template v-if="chips">
      <button class="ali-chip" :data-drop="isSmp ? '' : null" :aria-pressed="String(chipOn === '')" @click="setChip('')">全部</button>
      <button v-for="f in chipList" :key="f" class="ali-chip" :data-drop="isSmp ? f : null" :data-sort="isSmp ? f : null" :aria-pressed="String(chipOn === f)" @click="setChip(f)">{{ f }}</button>
    </template></div>
    <div class="ali-n-r"><AliSwitch v-model="s.link" label="" title="联动：选卡片时自动填 CLIP / VAE / 步数" aria-label="联动" /></div>
  </div>
  </div>
  <div class="ali-n-body">
  <AliGrid v-if="s.tab !== 'sample'" :key="s.tab" class="ali-n-grid" :ids="shown.map((t) => t.id)" sortable @reorder="(ids) => reorder(s.tab, ids)">
    <AliCard v-for="(t, n) in shown" :key="t.id" :index="n" :item="t" :cover="coverUrl(t)" :on="s.sel[s.tab].includes(t.id)" :dim="!s.sel[s.tab].includes(t.id)" editable
      :control="s.tab === 'lora' ? 'weight' : (t.key === 'checkpoints' ? '' : 'dtype')" :weight="Number(t.w ?? 1)" :dtype="t.dtype || 'default'"
      @toggle="toggle(s.tab, t.id)" @weight="t.w = $event" @dtype="t.dtype = $event" @edit="openGear(t)" @versions="openGear(t, 'list')" @menu="openMenu($event, t)" />
  </AliGrid>
  <AliGrid v-else key="sample" class="ali-n-grid" :ids="[]" sortable drag-only @drop-folder="moveSamples">
    <AliCard v-for="(x, n) in sampleShown" :key="x.id" :index="n" :item="{ id: x.id, title: x.name, badge: '样本' }" :cover="sampleCover(x)"
      :on="popId === x.id" @toggle="togglePop($event, x)" @menu="openSampleMenu($event, x)" />
  </AliGrid>
  <div v-if="s.tab !== 'sample' && !shown.length" class="ali-n-empty">
    <div>{{ s.tray[s.tab].length ? '没有匹配的卡片' : '还没有卡片：在后台网页里右键卡片，选「发送到工作流」' }}</div>
    <button class="ali-btn" @click="openManager">打开后台管理器</button>
  </div>
  <div v-if="s.tab === 'sample' && !sampleShown.length" class="ali-n-empty">还没有样本：在卡片上右键「保存为样本」</div>
  </div>

  <AliMenu v-if="s.menu" :x="s.menu.x" :y="s.menu.y" :items="s.menu.items" :kind="s.menu.kind" @pick="pick" @close="s.menu = null" />
  <CardModal v-if="s.modal" :key="s.modal.item.id + ':' + s.modal.rev" :item="s.modal.item" :kind="s.modal.kind" :view="s.modal.view" @close="s.modal = null" @saved="onSaved" @patched="(it) => store.syncItem(it.id, it)" />
  <SamplePanel v-if="popSample" :key="popSample.id" :sample="popSample" :anchor="s.pop.rect" @close="s.pop = null" @saved="onSampleSaved" @send="sendSample" />
  <ImagePicker v-if="s.picker" :images="s.picker.images" @pick="pickImg" @close="pickImg(null)" />
</div>`;

const TABS = [{ k: 'model', n: '大模型' }, { k: 'lora', n: '风格LoRA' }, { k: 'sample', n: '样本' }];

function mountPanel(node) {
  const wState = node.widgets.find((w) => w.name === 'state');
  Object.assign(wState, { hidden: true, computeSize: () => [0, -4], draw() {} });
  const store = createStore(node, wState);
  const { s } = store;
  node.__alili = store; nodes.add(node);

  const shown = Vue.computed(() => {
    const q = s.q.trim().toLowerCase();
    return s.tray[s.tab === 'sample' ? 'lora' : s.tab].filter((t) => (!s.fam || t.badge === s.fam) && (!q || `${t.title} ${t.version} ${t.file_name}`.toLowerCase().includes(q)));
  });
  const catsShown = Vue.computed(() => s.cats.filter((c) => s.samples.some((x) => x.category === c)));   // 空分类不在节点里显示
  const curCat = Vue.computed(() => (catsShown.value.includes(s.cat) ? s.cat : ''));   // 分类被删掉 / 变空后自动回到「全部」
  const sampleShown = Vue.computed(() => s.samples.filter((x) => (!curCat.value || x.category === curCat.value) && (!s.q.trim() || x.name.toLowerCase().includes(s.q.trim().toLowerCase()))));
  const fams = Vue.computed(() => (s.tab === 'sample' ? [] : [...new Set(s.tray[s.tab].map((t) => t.badge))]));
  const isSmp = Vue.computed(() => s.tab === 'sample');
  const chipList = Vue.computed(() => (isSmp.value ? catsShown.value : fams.value));        // 样本页的标签 = 自己建的分类
  const chipOn = Vue.computed(() => (isSmp.value ? curCat.value : s.fam));
  const setChip = (v) => { if (isSmp.value) s.cat = v; else s.fam = v; };
  const chips = Vue.computed(() => (isSmp.value ? catsShown.value.length > 0 : fams.value.length > 1));   // 有标签筛选 → 两行；没有 → 一行并上下居中
  // 拖动分类标签调整顺序：节点里只看得到非空分类，所以把新顺序「放回」完整分类列表里它们原来占的位置
  const sortOpt = Vue.computed(() => (isSmp.value ? { item: '[data-sort]', axis: 'x', onSort: async (keys) => {
    const it = [...keys]; const full = s.cats.map((c) => (catsShown.value.includes(c) ? it.shift() : c));
    s.cats = full;
    try { await post('sample_cats', { action: 'reorder', names: full }); } catch (e) { toast(e.message, 'err'); store.loadSamples(); }
  } } : null));
  // 把样本卡片拖到分类标签上松手 = 归入这个分类；拖到「全部」= 取消分类
  const moveSamples = async (ids, category) => {
    try { await post('sample_move', { ids, category }); await store.loadSamples(); toast(category ? `已放进「${category}」` : '已取消分类', 'ok'); }
    catch (e) { toast(e.message, 'err'); }
  };

  const openGear = async (t, view = 'params') => {
    try { s.modal = { item: await get('item?id=' + encodeURIComponent(t.id)), kind: s.tab, rev: 0, view }; }
    catch (e) { toast(e.message, 'err'); }
  };
  const openMenu = (e, t) => {
    const lora = s.tab === 'lora';
    s.menu = {
      x: e.clientX, y: e.clientY, kind: s.tab, t,
      items: [
        { label: '上传封面', act: 'upload' }, { label: '保存为封面', act: 'cover' },
        ...(lora && t.triggers?.length ? [{ label: '复制触发词', act: 'copy' }] : []),
        { sep: true }, { label: '保存为样本', act: 'sample' }, { sep: true }, { label: '移除', act: 'remove', danger: true },
      ],
    };
  };
  const openSampleMenu = (e, x) => { s.menu = { x: e.clientX, y: e.clientY, kind: 'sample', x2: x, items: [{ label: '删除样本', act: 'delSample', danger: true }] }; };
  const pick = async (act) => {
    const m = s.menu; s.menu = null;
    try {
      if (act === 'delSample') { await del('samples?id=' + m.x2.id); if (s.pop && s.pop.id === m.x2.id) s.pop = null; await store.loadSamples(); return; }
      const t = m.t;
      if (act === 'upload') { const f = await pickFile(); if (f) { const r = await uploadCover(t.id, f); store.syncItem(t.id, r.item); toast('封面已更新', 'ok'); } }
      else if (act === 'cover') await store.saveCover(t);
      else if (act === 'copy') copyText(t.triggers.join(', '));
      else if (act === 'sample') await store.saveSample();
      else if (act === 'remove') store.remove(m.kind, t.id);
    } catch (e) { toast(e.message, 'err'); }
  };
  const restoreSample = (x) => {
    if (!(x.state && (x.state.models || []).length)) return toast('这个样本没有记录节点里选的模型，无法还原', 'err');
    store.restore(x.state);
  };
  // 样本详情：点卡片在旁边弹出（无蒙版），再点同一张收起；「发送到工作流」在详情里
  const popId = Vue.computed(() => (s.pop ? s.pop.id : ''));
  const popSample = Vue.computed(() => (s.pop ? s.samples.find((x) => x.id === s.pop.id) || null : null));
  const togglePop = (rect, x) => { s.pop = s.pop && s.pop.id === x.id ? null : { id: x.id, rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom } }; };
  const onSampleSaved = (item) => { const i = s.samples.findIndex((x) => x.id === item.id); if (i >= 0) s.samples[i] = item; };
  const sendSample = (x) => { s.pop = null; restoreSample(x); };
  const onSaved = (oldId, item) => { store.syncItem(oldId, item); if (s.modal) s.modal = { item, kind: item.kind, rev: s.modal.rev + 1 }; };
  const pickImg = (img) => { const p = s.picker; s.picker = null; p?.res(img); };

  const root = document.createElement('div');
  root.style.cssText = 'width:100%;height:100%';
  const vueApp = Vue.createApp({
    components: { AliCard, AliSwitch, AliMenu, CardModal, SamplePanel, ImagePicker, AliTabs, AliGrid },
    directives: { sortList: vSortList },
    setup: () => ({ onWheel, s, TABS, shown, sampleShown, fams, chips, chipList, chipOn, isSmp, setChip, moveSamples, sortOpt, coverUrl, sampleCover, toast, toggle: store.toggle, restore: store.restore, reorder: store.reorder,
      openGear, openMenu, openSampleMenu, pick, onSaved, pickImg, restoreSample, popId, popSample, togglePop, onSampleSaved, sendSample, store, openManager: openManagerPage, panelBtn: MANAGER_BTN === 'panel' }),
    template: PANEL_TPL,
  });
  vueApp.mount(root);
  node.__aliUnmount = () => vueApp.unmount();

  node.widgets_start_y = 0;  // 控件从正文最顶端开始，利用「总模型 / 触发词」输出口旁边的空白区
  node.addDOMWidget('alili_panel', 'alili', root, { serialize: false, getMinHeight: () => 320 });
  if (node.size[0] < 700) node.setSize([780, 580]);
  store.load();
}

// ───────────── 注册 ─────────────
// 滚轮：默认交给 ComfyUI 画布（缩放 / 平移，按用户设置的导航模式走），所以鼠标在节点里也能缩放工作流；
// 按住 Alt 再滚 = 滚动卡片列表（卡片多、列表出现滚动条时用）。画布接口不可用时不拦截，让事件照常冒泡。
const WHEEL_SCROLL_KEY = 'altKey';
function onWheel(e) {
  if (e[WHEEL_SCROLL_KEY]) { e.stopPropagation(); return; }              // 不 preventDefault：卡片列表自己滚
  const cv = app.canvas;
  if (!cv || typeof cv.processMouseWheel !== 'function') return;
  e.preventDefault(); e.stopPropagation();                               // 已经由我们转交，防止 ComfyUI 再处理一次造成双倍缩放
  cv.processMouseWheel(e);
}

app.registerExtension({
  name: 'Alili.ModelManager',
  setup() {
    api.addEventListener('execution_start', () => { fresh = true; });
    api.addEventListener('executed', (e) => {
      const d = e.detail?.output || {};
      const imgs = [...(d.images || []), ...(d.alili_images || [])];
      if (!imgs.length) return;
      if (fresh) { recent.length = 0; fresh = false; }
      recent.push(...imgs.map((i) => ({
        filename: i.filename,
        subfolder: i.subfolder || '',
        type: i.type || 'output',
      })));
      if (recent.length > 16) recent.splice(0, recent.length - 16);
    });
    api.addEventListener('alili.send', async (e) => {  // 后台网页 → 节点
      const d = e.detail, all = [...nodes].filter((n) => n.graph);
      if (!all.length) return;
      if (d.mode === 'hello') return all.forEach((n) => n.__alili.report(true));
      const target = await pickNode(all, '发送到哪个 Alili 节点？');
      target?.__alili.receive(d);
    });
    api.addEventListener('alili.item', (e) => {  // 后台改了卡片 → 节点同步
      const d = e.detail;
      nodes.forEach((n) => {
        if (d.removed) { ['lora', 'model'].forEach((k) => n.__alili.remove(k, d.removed)); }
        else n.__alili.syncItem(d.old_id, d.item);
      });
    });
    api.addEventListener('alili.samples', () => nodes.forEach((n) => n.__alili.loadSamples()));
  },
  beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== 'AliliModelManager') return;
    const created = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () { created?.apply(this, arguments); mountPanel(this); };
    const conf = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () { conf?.apply(this, arguments); this.__alili?.load(); };
    if (MANAGER_BTN === 'title') {   // 位置 1：标题栏右上角的「打开后台页面」箭头
      const fg = nodeType.prototype.onDrawForeground;
      nodeType.prototype.onDrawForeground = function (ctx) {
        fg?.apply(this, arguments);
        if (this.flags?.collapsed) return;
        const b = titleBtn(this);
        ctx.save();
        ctx.translate(b.x, b.y); ctx.scale(b.z / 24, b.z / 24);
        ctx.strokeStyle = this.__aliHover ? '#ffffff' : 'rgba(255,255,255,.62)';
        ctx.lineWidth = 2; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        ctx.stroke(EXT_ICON);
        ctx.restore();
      };
      const inBtn = (node, pos) => { const b = titleBtn(node); return pos && pos[0] >= b.x - 4 && pos[0] <= b.x + b.z + 4 && pos[1] >= b.y - 4 && pos[1] <= b.y + b.z + 4; };
      const md = nodeType.prototype.onMouseDown;
      nodeType.prototype.onMouseDown = function (e, pos) {
        if (inBtn(this, pos)) { openManagerPage(); return true; }
        return md?.apply(this, arguments);
      };
      const mm = nodeType.prototype.onMouseMove;
      nodeType.prototype.onMouseMove = function (e, pos) {
        const h = inBtn(this, pos);
        if (h !== !!this.__aliHover) { this.__aliHover = h; app.canvas?.setDirty?.(true, true); }
        return mm?.apply(this, arguments);
      };
      const ml = nodeType.prototype.onMouseLeave;
      nodeType.prototype.onMouseLeave = function () { if (this.__aliHover) { this.__aliHover = false; app.canvas?.setDirty?.(true, true); } return ml?.apply(this, arguments); };
    }
    const rem = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function () {
      rem?.apply(this, arguments);
      nodes.delete(this); this.__aliUnmount?.();
      post('state', { node_id: this.id, ids: [] }).catch(() => {});
    };
  },
});
