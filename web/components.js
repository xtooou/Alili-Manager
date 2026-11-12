// 共用 Vue 组件：图标 / 开关 / 标签页 / 卡片 / 卡片网格(拖拽排序) / 右键菜单 / 基础模型下拉 / 卡片弹窗 / 样本详情面板 / 输出图选择
import { defineComponent, ref, reactive, computed, watch, onMounted, onBeforeUnmount, nextTick } from './vue.esm-browser.prod.js';
import { DTYPES, get, post, fmtSize, copyText, toast, iconUrl, loadIcons, coverUrl } from './core.js';

loadIcons();
// 没有封面的卡片显示这张默认图：放在插件根目录 images/Generic.jpg（文件不存在就不显示图片，不会出现破图）
export const DEFAULT_COVER = '/alili/images/Generic.jpg';
const COPY_ICON = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h11v14z"/></svg>';

// 图标：svg 文件存在就用（跟随文字颜色），不存在就显示文字符号
export const AliIcon = defineComponent({
  props: { name: String, fb: String },
  setup(props) { return { url: computed(() => iconUrl(props.name)) }; },
  template: `<i v-if="url" class="ali-ico" :style="{ '--ico': 'url(' + url + ')' }"></i><span v-else class="ali-ico-fb">{{ fb }}</span>`,
});

// 多选 / 单选开关
export const AliSwitch = defineComponent({
  props: { modelValue: Boolean, label: String },
  emits: ['update:modelValue'],
  template: `<button type="button" class="ali-switch" role="switch" :aria-checked="String(modelValue)" @click="$emit('update:modelValue', !modelValue)"><i></i>{{ label }}</button>`,
});

// 标签页：选中的胶囊会滑到新位置
export const AliTabs = defineComponent({
  props: { tabs: Array, modelValue: String },
  emits: ['update:modelValue'],
  setup(props) {
    const root = ref(null), pill = reactive({ x: 0, w: 0, on: false });
    const place = () => {
      const b = root.value && root.value.querySelector('[aria-selected="true"]');
      if (b) { pill.x = b.offsetLeft; pill.w = b.offsetWidth; pill.on = true; }
    };
    let ro;
    onMounted(() => {
      nextTick(place);
      ro = new ResizeObserver(place); ro.observe(root.value); root.value.querySelectorAll('button').forEach((b) => ro.observe(b));
      document.fonts && document.fonts.ready.then(place);
    });
    onBeforeUnmount(() => ro && ro.disconnect());
    watch(() => props.modelValue, () => nextTick(place));
    return { root, pill };
  },
  template: `<nav ref="root" class="ali-tabs" role="tablist"><i class="ali-pill" :class="{ 'is-on': pill.on }" :style="{ transform: 'translateX(' + pill.x + 'px)', width: pill.w + 'px' }"></i>
    <button v-for="t in tabs" :key="t.k" class="ali-tab" role="tab" :aria-selected="String(modelValue === t.k)" @click="$emit('update:modelValue', t.k)">{{ t.n }}</button></nav>`,
});

// 卡片：悬停时有跟手的 3D 倾斜 + 高光（rAF 平滑插值）；LoRA 底部权重 / 大模型底部数据类型
export const AliCard = defineComponent({
  components: { AliIcon },
  props: { item: Object, cover: String, on: Boolean, dim: Boolean, control: String, weight: Number, dtype: String, editable: Boolean, sel: Boolean, index: { type: Number, default: 0 }, fav: { type: Boolean, default: undefined } },
  emits: ['toggle', 'menu', 'edit', 'fav', 'weight', 'dtype', 'versions'],   // editable：顶部标签可点击 = 编辑（原来右上角的笔）
  setup(props, { emit }) {
    const el = ref(null), bad = ref(''), noDefault = ref(false);
    const src = computed(() => (props.cover && bad.value !== props.cover ? props.cover : DEFAULT_COVER));
    const onImgErr = () => { if (src.value === DEFAULT_COVER) noDefault.value = true; else bad.value = props.cover; };  // 真封面加载失败 → 退回默认图；默认图也没有 → 隐藏
    const step = (d) => emit('weight', Math.round((props.weight + d) * 100) / 100);
    const typed = (e) => { const v = parseFloat(e.target.value); if (isNaN(v)) e.target.value = props.weight.toFixed(2); else emit('weight', v); };
    // 光标在权重输入框里时，滚轮 = 左右按钮（每格 0.05，往上滚加、往下滚减）；光标不在里面时不处理，滚轮照常交给画布缩放
    const wheel = (e) => {
      if (document.activeElement !== e.target) return;
      e.preventDefault(); e.stopPropagation();
      const typedVal = parseFloat(e.target.value), base = isNaN(typedVal) ? props.weight : typedVal;   // 输入了还没回车的数字也算进去
      emit('weight', Math.round((base + (e.deltaY < 0 ? 0.05 : -0.05)) * 100) / 100);
    };
    return { el, step, typed, wheel, DTYPES, src, onImgErr, noDefault, DEFAULT_COVER };
  },
  template: `
  <article ref="el" class="ali-card" :class="{ 'is-off': dim }" :data-id="item.id" :data-on="String(on)" :data-sel="String(sel)" :style="{ '--i': index }"
    @click="$emit('toggle', $event.currentTarget.getBoundingClientRect())" @contextmenu.prevent.stop="$emit('menu', $event)">
    <div class="ali-card-in">
      <img v-if="!noDefault || src !== DEFAULT_COVER" class="ali-cover" :class="{ 'is-default': src === DEFAULT_COVER }" :src="src" loading="lazy" draggable="false" @error="onImgErr">
      <div class="ali-card-top">
        <span class="ali-card-l">
          <button 
            v-if="fav !== undefined" 
            class="ali-ib" 
            :class="{ 'is-on': fav }" 
            :style="{
              background: 'transparent',
              border: 'none',
              boxShadow: 'none',
              fontSize: '18px',
              lineHeight: '1',
              padding: '0',
              width: 'auto',
              height: 'auto',
              cursor: 'pointer',
              filter: fav ? 'none' : 'grayscale(100%)',
              opacity: fav ? 1 : 0.45,
              transition: 'filter .2s, opacity .2s, transform .15s'
            }" 
            :title="fav ? '取消收藏' : '收藏'" 
            @click.stop="$emit('fav')">
            ⭐
          </button>
        </span>
        <button v-if="editable" type="button" class="ali-card-tag is-btn" title="点击编辑" @click.stop="$emit('edit')">{{ item.badge || item.family }}</button>
        <span v-else class="ali-card-tag">{{ item.badge || item.family }}</span>
        <span class="ali-card-r"><button v-if="item.update" type="button" class="ali-upd" :title="'CivitAI 有新版本：' + ((item.latest && item.latest.name) || '') + '（点击查看版本列表）'" @click.stop="$emit('versions')" @pointerdown.stop><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5"/></svg></button></span>
      </div>
      <div class="ali-card-info">
        <h3 class="ali-card-name" :title="item.title">{{ item.title }}</h3>
        <div v-if="item.version" class="ali-card-meta"><span class="ali-badge">{{ item.version }}</span></div>
        <div v-if="control === 'weight'" class="ali-step" @click.stop @pointerdown.stop>
          <button @click="step(-0.05)">‹</button><input :value="weight.toFixed(2)" @change="typed" @wheel="wheel"><button @click="step(0.05)">›</button>
        </div>
        <select v-else-if="control === 'dtype'" class="ali-select" :value="dtype" @click.stop @pointerdown.stop @change="$emit('dtype', $event.target.value)">
          <option v-for="d in DTYPES" :key="d" :value="d">{{ d }}</option>
        </select>
      </div>
    </div>
  </article>`,
});

// 卡片网格：自动换行；筛选 / 排序 / 缩放时卡片平滑换位；
//   sortable：按住卡片拖动排序（dragOnly = 只能拖进分类，不重排），拖到左边文件夹上松手 = 移动到那个文件夹（带 data-drop 属性的元素就是落点）；
//   selectable：按住 Ctrl 拖出框选（碰到卡片边缘也算选中），Ctrl+单击切换单张；已选中多张时拖其中一张 = 一起拖
export const AliGrid = defineComponent({
  props: { ids: Array, sortable: Boolean, dragOnly: Boolean, selectable: Boolean, selected: { type: Array, default: () => [] } },   // dragOnly：可以拖着卡片放进分类 / 文件夹，但不重排（样本用）
  emits: ['reorder', 'select', 'drop-folder', 'menu-blank'],
  setup(props, { emit }) {
    const g = ref(null);
    let st = null, raf = 0, swapAt = 0, suppress = false, bd = null, hot = null;
    const root = () => g.value.$el;
    const rel = (x, y) => { const r = root().getBoundingClientRect(); return { x: x - r.left + root().scrollLeft, y: y - r.top + root().scrollTop }; };
    const freeze = (el) => Object.assign(el.style, { position: 'absolute', left: el.offsetLeft + 'px', top: el.offsetTop + 'px', width: el.offsetWidth + 'px', height: el.offsetHeight + 'px', paddingBottom: '0', margin: '0', pointerEvents: 'none' });
    const folderAt = (x, y) => { const e = document.elementFromPoint(x, y); return e && e.closest ? e.closest('[data-drop]') : null; };
    const setHot = (el) => { if (hot === el) return; if (hot) hot.classList.remove('is-drop'); hot = el; if (hot) hot.classList.add('is-drop'); };
    const edgeScroll = (cy, r, edge) => {
      if (cy < r.top + edge) root().scrollTop -= Math.ceil((r.top + edge - cy) / 4);
      else if (cy > r.bottom - edge) root().scrollTop += Math.ceil((cy - (r.bottom - edge)) / 4);
    };

    // ── 拖动排序 / 拖进文件夹 ──
    const tick = () => {
      if (!st || !st.drag) { raf = 0; return; }
      const r = root().getBoundingClientRect();
      edgeScroll(st.cy, r, 56);
      setHot(folderAt(st.cx, st.cy));
      const p = rel(st.cx, st.cy), el = st.el;
      el.style.translate = `${p.x - st.gx - el.offsetLeft}px ${p.y - st.gy - el.offsetTop}px`;
      const inside = st.cx >= r.left && st.cx <= r.right && st.cy >= r.top && st.cy <= r.bottom;
      if (!st.multi && !props.dragOnly && !hot && inside && performance.now() - swapAt > 160) {   // 多选拖拽不重排；指针在文件夹上 / 离开卡片区时也不重排
        for (const c of root().children) {
          if (c === el || !c.classList.contains('ali-card') || c.style.position === 'absolute') continue;
          if (p.x >= c.offsetLeft && p.x <= c.offsetLeft + c.offsetWidth && p.y >= c.offsetTop && p.y <= c.offsetTop + c.offsetHeight) {
            const ids = [...props.ids], from = ids.indexOf(st.id), to = ids.indexOf(c.dataset.id);
            if (from >= 0 && to >= 0 && from !== to) { ids.splice(from, 1); ids.splice(to, 0, st.id); emit('reorder', ids); swapAt = performance.now(); }
            break;
          }
        }
      }
      raf = requestAnimationFrame(tick);
    };
    const move = (e) => {
      if (!st) return;
      st.cx = e.clientX; st.cy = e.clientY;
      if (!st.drag) {
        if (Math.hypot(e.clientX - st.x0, e.clientY - st.y0) < 8) return;
        st.drag = true; const p = rel(e.clientX, e.clientY);
        st.gx = p.x - st.el.offsetLeft; st.gy = p.y - st.el.offsetTop;
        st.el.classList.add('is-dragging'); root().classList.add('is-sorting');
        if (st.multi) { root().classList.add('is-multi'); st.el.dataset.count = st.multi.length; }
        raf = requestAnimationFrame(tick);
      }
    };
    const up = () => {
      removeEventListener('pointermove', move); removeEventListener('pointerup', up); removeEventListener('pointercancel', up);
      if (st && st.drag) {
        const el = st.el, target = hot, ids = st.multi || [st.id];
        setHot(null);
        el.classList.remove('is-dragging'); root().classList.remove('is-sorting', 'is-multi'); delete el.dataset.count;
        el.style.translate = '0px 0px'; setTimeout(() => { el.style.translate = ''; }, 650);
        suppress = true; setTimeout(() => { suppress = false; }, 0);
        if (target) emit('drop-folder', ids, target.dataset.drop || '');
      }
      st = null;
    };

    // ── Ctrl 框选 ──
    const btick = () => {
      if (!bd || !bd.el) return;
      const r = root().getBoundingClientRect();
      edgeScroll(bd.cy, r, 40);
      const p = rel(bd.cx, bd.cy);
      const L = Math.min(bd.x0, p.x), T = Math.min(bd.y0, p.y), R = Math.max(bd.x0, p.x), B = Math.max(bd.y0, p.y);
      const sx = r.left - root().scrollLeft, sy = r.top - root().scrollTop;   // 内容坐标 → 屏幕坐标，并裁剪在卡片区里
      const l = Math.max(L + sx, r.left), t = Math.max(T + sy, r.top), rr = Math.min(R + sx, r.right), b = Math.min(B + sy, r.bottom);
      Object.assign(bd.el.style, { left: l + 'px', top: t + 'px', width: Math.max(0, rr - l) + 'px', height: Math.max(0, b - t) + 'px' });
      const hit = [];
      for (const c of root().children) {   // 只要和选框有重叠（碰到边缘）就算选中
        if (!c.classList.contains('ali-card') || !c.dataset.id) continue;
        if (c.offsetLeft <= R && c.offsetLeft + c.offsetWidth >= L && c.offsetTop <= B && c.offsetTop + c.offsetHeight >= T) hit.push(c.dataset.id);
      }
      if (hit.length !== bd.last.length || hit.some((id, i) => id !== bd.last[i])) { bd.last = hit; emit('select', hit); }
      bd.raf = requestAnimationFrame(btick);
    };
    const bmove = (e) => {
      if (!bd) return;
      bd.cx = e.clientX; bd.cy = e.clientY;
      if (!bd.moved) {
        if (Math.hypot(e.clientX - bd.sx, e.clientY - bd.sy) < 4) return;
        bd.moved = true; bd.el = document.createElement('div'); bd.el.className = 'ali-band'; document.body.appendChild(bd.el);
        root().classList.add('is-banding'); bd.raf = requestAnimationFrame(btick);
      }
    };
    const bup = () => {
      removeEventListener('pointermove', bmove); removeEventListener('pointerup', bup); removeEventListener('pointercancel', bup);
      if (!bd) return;
      const b = bd; bd = null; cancelAnimationFrame(b.raf);
      if (b.el) b.el.remove();
      root().classList.remove('is-banding');
      suppress = true; setTimeout(() => { suppress = false; }, 0);   // 框选 / Ctrl+单击 不要触发卡片自己的点击
      if (!b.moved && b.card) {   // Ctrl+单击 = 切换这一张
        const cur = new Set(props.selected);
        if (cur.has(b.card)) cur.delete(b.card); else cur.add(b.card);
        emit('select', [...cur]);
      }
    };
    const startBand = (e) => {
      const p0 = rel(e.clientX, e.clientY), c = e.target.closest('.ali-card');
      bd = { x0: p0.x, y0: p0.y, sx: e.clientX, sy: e.clientY, cx: e.clientX, cy: e.clientY, moved: false, el: null, raf: 0, last: [], card: c && c.parentNode === root() ? c.dataset.id : null };
      addEventListener('pointermove', bmove); addEventListener('pointerup', bup); addEventListener('pointercancel', bup);
      e.preventDefault();
    };

    const down = (e) => {
      if (e.button !== 0) return;
      if (props.selectable && (e.ctrlKey || e.metaKey) && !e.target.closest('input,select,textarea')) return startBand(e);
      const el = e.target.closest('.ali-card');
      if (props.selected.length && !(el && props.selected.includes(el.dataset.id))) emit('select', []);   // 点空白 / 点没选中的卡片 = 取消框选
      if (!props.sortable || e.target.closest('button,input,select,textarea,a')) return;
      if (!el || el.parentNode !== root()) return;
      const multi = props.selected.length > 1 && props.selected.includes(el.dataset.id) ? [...props.selected] : null;
      st = { el, id: el.dataset.id, multi, x0: e.clientX, y0: e.clientY, cx: e.clientX, cy: e.clientY, drag: false };
      addEventListener('pointermove', move); addEventListener('pointerup', up); addEventListener('pointercancel', up);
    };
    const ctx = (e) => {   // 框选后在空白处右键，也弹出批量菜单
      if (!props.selected.length || e.target.closest('.ali-card')) return;
      e.preventDefault(); emit('menu-blank', { x: e.clientX, y: e.clientY });
    };
    onMounted(() => {
      root().addEventListener('pointerdown', down);
      root().addEventListener('contextmenu', ctx);
      root().addEventListener('click', (e) => { if (suppress) { e.stopPropagation(); e.preventDefault(); } }, true);
    });
    onBeforeUnmount(() => { cancelAnimationFrame(raf); up(); bup(); });
    return { g, freeze };
  },
  template: `<TransitionGroup ref="g" tag="section" class="ali-grid" name="ali-flip" appear @before-leave="freeze"><slot /></TransitionGroup>`,
});

// 拖动排序指令 v-sort-list="{ item: '[data-sort]', axis: 'x' | 'y', onSort: (keys) => … }"（值为 null = 不启用）
// 按住带 data-sort="键" 的元素拖动（超过 8px 才算拖动，所以不影响点击），松手时按指针位置插入，onSort 收到新的键顺序
export const vSortList = {
  mounted(el, b) {
    el.__sl = b;
    let st = null, suppress = false;
    const opt = () => (el.__sl && el.__sl.value) || null;
    const items = () => [...el.querySelectorAll(opt().item)];
    const mark = (target, last) => {
      for (const n of items()) n.classList.remove('ins-b', 'ins-a');
      if (target) target.classList.add('ins-b'); else if (last) last.classList.add('ins-a');
    };
    const locate = (e) => {   // 指针落在谁的前面（null = 放到最后）
      const horiz = opt().axis === 'x', pos = horiz ? e.clientX : e.clientY;
      const others = items().filter((n) => n !== st.el);
      const target = others.find((n) => { const r = n.getBoundingClientRect(); return pos < (horiz ? r.left + r.width / 2 : r.top + r.height / 2); }) || null;
      return { target, last: others[others.length - 1] || null };
    };
    const move = (e) => {
      if (!st) return;
      if (!st.drag) { if (Math.hypot(e.clientX - st.x0, e.clientY - st.y0) < 8) return; st.drag = true; st.el.classList.add('is-sorting'); }
      st.el.style.translate = `${e.clientX - st.x0}px ${e.clientY - st.y0}px`;
      const { target, last } = locate(e); mark(target, last);
    };
    const up = (e) => {
      removeEventListener('pointermove', move); removeEventListener('pointerup', up); removeEventListener('pointercancel', up);
      if (!st) return;
      const cur = st; st = null;
      if (!cur.drag) return;
      const o = opt(); st = cur; const { target } = o ? locate(e) : { target: null }; st = null;
      for (const n of items()) n.classList.remove('ins-b', 'ins-a');
      cur.el.classList.remove('is-sorting'); cur.el.style.translate = '';
      suppress = true; setTimeout(() => { suppress = false; }, 0);
      if (!o) return;
      const keys = items().map((n) => n.dataset.sort).filter((k) => k !== cur.el.dataset.sort);
      const at = target ? keys.indexOf(target.dataset.sort) : keys.length;
      keys.splice(at < 0 ? keys.length : at, 0, cur.el.dataset.sort);
      const before = items().map((n) => n.dataset.sort);
      if (keys.some((k, i) => k !== before[i])) o.onSort(keys);
    };
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !opt() || e.target.closest('input,textarea,select')) return;
      const t = e.target.closest(opt().item);
      if (!t || !el.contains(t)) return;
      st = { el: t, x0: e.clientX, y0: e.clientY, drag: false };
      addEventListener('pointermove', move); addEventListener('pointerup', up); addEventListener('pointercancel', up);
    });
    el.addEventListener('click', (e) => { if (suppress) { e.stopPropagation(); e.preventDefault(); } }, true);
  },
  updated(el, b) { el.__sl = b; },
};

// 进度条（拉取 CivitAI 数据 / 检查更新用）：底部悬浮，右边 n/n，颜色跟着 job.kind（大模型蓝 / LoRA 粉），运行中右边有 ✕ 可取消
export const AliProgress = defineComponent({
  props: { job: Object },
  emits: ['cancel'],
  template: `<Transition name="ali-prog"><div v-if="job.show" class="ali-prog" :class="'is-' + job.state" :data-kind="job.kind" role="status">
    <div class="ali-prog-head">
      <i class="ali-prog-ico" aria-hidden="true">{{ job.state === 'done' ? '✓' : job.state === 'run' ? '' : '!' }}</i>
      <span class="ali-prog-title">{{ job.cancel && job.state === 'run' ? '正在取消…' : job.title }}</span>
      <span class="ali-prog-n">{{ job.done }}/{{ job.total }}</span>
      <button v-if="job.state === 'run'" class="ali-close ali-prog-x" title="取消" :disabled="job.cancel" @click="$emit('cancel')">✕</button>
    </div>
    <div class="ali-prog-bar"><i :style="{ width: (job.total ? Math.min(100, job.done / job.total * 100) : 0) + '%' }"></i></div>
  </div></Transition>`,
});

// 右键菜单：items = [{label, act, danger, todo}] 或 {sep:true}
export const AliMenu = defineComponent({
  props: { x: Number, y: Number, items: Array, kind: String },
  emits: ['pick', 'close'],
  setup(props, { emit }) {
    const el = ref(null), pos = reactive({ x: props.x, y: props.y });
    const away = (e) => { if (!el.value || !el.value.contains(e.target)) emit('close'); };
    onMounted(async () => {
      await nextTick();
      const r = el.value.getBoundingClientRect();
      pos.x = Math.max(8, Math.min(props.x, innerWidth - r.width - 8));
      pos.y = Math.max(8, Math.min(props.y, innerHeight - r.height - 8));
      addEventListener('pointerdown', away, true);
      addEventListener('blur', () => emit('close'));
    });
    onBeforeUnmount(() => removeEventListener('pointerdown', away, true));
    return { el, pos };
  },
  template: `<Teleport to="body"><div ref="el" class="ali-menu is-open" :data-kind="kind" :style="{ left: pos.x + 'px', top: pos.y + 'px' }" @contextmenu.prevent>
    <template v-for="(it, i) in items" :key="i"><hr v-if="it.sep"><button v-else :class="{ 'is-danger': it.danger, 'is-todo': it.todo }" @click="$emit('pick', it.act)">{{ it.label }}</button></template>
  </div></Teleport>`,
});

// 基础模型下拉：像普通下拉框一样直接点开选择，也能输入搜索；找不到可直接添加
export const BasePicker = defineComponent({
  props: { modelValue: String, table: Array },
  emits: ['update:modelValue', 'add'],
  setup(props, { emit }) {
    const q = ref(''), open = ref(false);
    const list = computed(() => props.table.filter((e) => e.name.toLowerCase().includes(q.value.trim().toLowerCase())));
    const canAdd = computed(() => q.value.trim() && !props.table.some((e) => e.name.toLowerCase() === q.value.trim().toLowerCase()));
    const badge = computed(() => (props.table.find((e) => e.name === props.modelValue) || {}).badge || '');
    const pick = (name) => { emit('update:modelValue', name); open.value = false; q.value = ''; };
    const show = () => { open.value = true; q.value = ''; };
    return { q, open, list, canAdd, badge, pick, show, add: () => { emit('add', q.value.trim()); pick(q.value.trim()); } };
  },
  template: `<div class="ali-picker" :class="{ 'is-open': open }">
    <input class="ali-picker-input" :value="open ? q : (modelValue || '')" :placeholder="open ? (modelValue || '搜索基础模型…') : '选择基础模型'" @focus="show" @click="open = true" @input="q = $event.target.value" @blur="open = false" @keydown.esc="$event.target.blur()">
    <span class="ali-picker-end"><small v-if="badge && !open">{{ badge }}</small><i class="ali-picker-caret"></i></span>
    <div v-if="open" class="ali-picker-list" @mousedown.prevent>
      <button v-for="e in list" :key="e.name" :class="{ 'is-cur': e.name === modelValue }" @click="pick(e.name)">{{ e.name }}<small>{{ e.badge }}</small></button>
      <button v-if="canAdd" @click="add">＋ 添加「{{ q.trim() }}」</button>
      <div v-if="!list.length && !canAdd" class="ali-hint" style="padding:8px">没有匹配项</div>
    </div></div>`,
});

// 卡片弹窗：LoRA / 大模型共用外壳；kind = 'model' 时没有「触发词」区块。
// 左上角 ← → 像浏览器一样在「参数页」和「模型列表页」之间前进 / 后退；卡片上的更新箭头直接打开列表页。
const ARROW = (d, z = 18) => `<svg viewBox="0 0 24 24" width="${z}" height="${z}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`;
const fmtDate = (t) => { const d = new Date(t); return isNaN(d) ? '—' : `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`; };

export const CardModal = defineComponent({
  components: { BasePicker, AliIcon },
  props: { item: Object, kind: String, view: { type: String, default: 'params' } },
  emits: ['close', 'saved', 'patched'],
  setup(props, { emit }) {
    const o = props.item;
    const d = reactive({ title: o.title, version: o.version, file_name: o.file_name, base_model: o.base_model, notes: o.notes || '', triggers: (o.triggers || []).join(', ') });
    const ed = ref(null), table = ref([]), busy = ref(false), pulling = ref(false), checking = ref(false), ignoring = ref(0);
    // 浏览器式历史：从卡片箭头进来时，历史是 [参数页, 列表页]，停在列表页，点 ← 能回参数页
    const hist = ref(props.view === 'list' ? ['params', 'list'] : ['params']), idx = ref(hist.value.length - 1);
    const cur = computed(() => hist.value[idx.value]);
    // 前进：有「前进历史」就前进；在参数页且这个模型有版本数据时，也可以直接前进到列表页（不用等检测到新版本）；没有版本数据就保持灰色
    const canBack = computed(() => idx.value > 0), canFwd = computed(() => idx.value < hist.value.length - 1 || (cur.value === 'params' && rows.value.length > 0));
    const go = (n) => {
      if (n > 0 && idx.value >= hist.value.length - 1) return canFwd.value && open('list');
      const i = idx.value + n; if (i >= 0 && i < hist.value.length) { idx.value = i; ed.value = null; }
    };
    const open = (v) => { if (cur.value === v) return; hist.value = [...hist.value.slice(0, idx.value + 1), v]; idx.value = hist.value.length - 1; ed.value = null; };

    const rows = ref(o.versions || []), author = ref(o.author || ''), checked = ref(!!o.update_checked), hasNew = ref(!!o.update), latestName = ref((o.latest && o.latest.name) || '');
    const apply = (it) => { rows.value = it.versions || []; author.value = it.author || ''; checked.value = !!it.update_checked; hasNew.value = !!it.update; latestName.value = (it.latest && it.latest.name) || ''; };
    const missSize = computed(() => rows.value.some((v) => !v.size));
    const pageUrl = (v) => `${o.civ_base || 'https://civitai.com'}/models/${o.model_id}?modelVersionId=${v.id}`;   // 这个版本自己的发布页，不是作者主页
    const authorUrl = computed(() => (author.value ? `${o.civ_base || 'https://civitai.com'}/user/${encodeURIComponent(author.value)}` : ''));
    const openUrl = (u) => window.open(u, '_blank', 'noopener');
    const cover = computed(() => coverUrl(o));

    onMounted(async () => { try { table.value = await get('base_models'); } catch {} });
    const toggle = (k) => { ed.value = ed.value === k ? null : k; };
    const words = computed(() => d.triggers.split(/[,，\n]/).map((s) => s.trim()).filter(Boolean));
    const status = computed(() => !checked.value ? { t: '未检查更新', n: false } : hasNew.value ? { t: '有新版本 ' + latestName.value, n: true } : { t: '已是最新', n: false });
    const addBase = async (name) => { try { table.value = await post('base_models', { name }); } catch (e) { toast(e.message, 'err'); } };
    const reveal = () => post('reveal', { id: o.id }).catch((e) => toast(e.message, 'err'));

    // 只拉触发词：不动本地文件，结果填进输入框，点「保存」才生效
    const pull = async () => {
      pulling.value = true;
      try {
        const r = await post('civitai_triggers', { id: o.id });
        if (!r.words.length) return toast('CivitAI 上这个版本没有填触发词', 'err');
        d.triggers = r.words.join(', ');
        toast(`已拉取 ${r.words.length} 个触发词，点「保存」后生效`, 'ok');
      } catch (e) { toast(e.message, 'err'); } finally { pulling.value = false; }
    };
    // 列表页：没有版本数据时，直接在这里检查更新
    const check = async () => {
      checking.value = true;
      try { const r = await post('check_update', { id: o.id }); apply(r.item); emit('patched', r.item); toast(r.has_update ? `有新版本：${r.latest.name}` : '已是最新版本', 'ok'); }
      catch (e) { toast(e.message, 'err'); } finally { checking.value = false; }
    };
    // 忽略 / 取消忽略：立刻生效并保存（卡片上的更新箭头会跟着消失）
    const ignore = async (v) => {
      ignoring.value = v.id;
      try { const it = await post('meta', { id: o.id, patch: v.ignored ? { unignore_version: v.id } : { ignore_version: v.id } }); apply(it); emit('patched', it); toast(v.ignored ? '已取消忽略' : '已忽略此更新', 'ok'); }
      catch (e) { toast(e.message, 'err'); } finally { ignoring.value = 0; }
    };

    const save = async () => {
      if (!d.title.trim() || !d.file_name.trim()) return toast('标题和文件名不能为空', 'err');
      busy.value = true;
      try {
        const patch = {};
        if (d.title !== o.title) patch.title = d.title;
        if (d.version !== o.version) patch.version = d.version;
        if (d.base_model !== o.base_model) patch.base_model = d.base_model;
        if (d.notes !== (o.notes || '')) patch.notes = d.notes;
        if (props.kind === 'lora' && words.value.join('\n') !== (o.triggers || []).join('\n')) patch.triggers = words.value;
        let it = Object.keys(patch).length ? await post('meta', { id: o.id, patch }) : o;
        if (d.file_name !== o.file_name) it = (await post('rename', { id: o.id, new_name: d.file_name.trim() })).item;  // 模型/封面/元数据 3 个文件一起改
        emit('saved', o.id, it);
        emit('close');
      } catch (e) { toast(e.message, 'err'); } finally { busy.value = false; }
    };
    return { d, ed, table, toggle, words, status, addBase, reveal, pull, pulling, save, busy, fmtSize, copyText, COPY_ICON,
      cur, canBack, canFwd, go, open, rows, missSize, pageUrl, authorUrl, openUrl, cover, check, checking, ignore, ignoring, fmtDate, checked,
      EXT: ARROW('M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5', 14),
      LEFT: ARROW('M19 12H5M11 6l-6 6 6 6'), RIGHT: ARROW('M5 12h14M13 6l6 6-6 6') };
  },
  template: `<Teleport to="body"><div class="ali-mask is-open" :data-kind="kind" @mousedown.self="$emit('close')">
  <section class="ali-modal" :data-kind="kind" role="dialog" aria-modal="true">
    <header class="ali-modal-head">
      <div class="ali-nav">
        <button type="button" title="后退" :disabled="!canBack" @click="go(-1)" v-html="LEFT"></button>
        <button type="button" :title="canFwd ? '前进' : '还没有版本数据：先对模型「刷新 CivitAI 数据」或「检查更新」'" :disabled="!canFwd" @click="go(1)" v-html="RIGHT"></button>
      </div>
      <div v-if="cur === 'params'" class="ali-field-act" :class="{ 'is-editing': ed === 'title' }" style="min-width:0;flex:1">
        <h2 class="ali-val ali-modal-title" style="min-height:0">{{ d.title }}</h2>
        <input class="ali-edit-input" v-model="d.title" @keydown.enter="ed = null">
        <button class="ali-pen" title="编辑" @click="toggle('title')"><AliIcon name="pen" fb="✎" /></button>
      </div>
      <h2 v-else class="ali-modal-title" style="min-width:0;flex:1">{{ d.title }} · 模型列表</h2>
      <button class="ali-close" title="关闭" @click="$emit('close')">✕</button>
    </header>

    <div v-if="cur === 'params'" class="ali-modal-body">
      <div class="ali-field" :class="{ 'is-editing': ed === 'version' }">
        <div class="ali-field-top is-tall">
          <span class="ali-field-lead"><span>版本</span>
            <button v-if="rows.length" type="button" class="ali-status is-btn" :class="{ 'is-new': status.n }" title="查看版本列表" @click="open('list')">{{ status.t }}</button>
            <span v-else class="ali-status">{{ status.t }}</span></span>
          <span class="ali-act-col"><button class="ali-pen" title="编辑" @click="toggle('version')"><AliIcon name="pen" fb="✎" /></button>
            <button class="ali-btn is-sm" :disabled="!authorUrl" :title="authorUrl ? '' : '先「检查更新」才能拿到作者信息'" @click="openUrl(authorUrl)">作者主页</button></span>
        </div>
        <div class="ali-val" :class="{ 'is-muted': !d.version }">{{ d.version || '未设置' }}</div>
        <input class="ali-edit-input" v-model="d.version" @keydown.enter="ed = null">
      </div>
      <div class="ali-field" :class="{ 'is-editing': ed === 'file_name' }">
        <div class="ali-field-top is-tall"><span>文件名</span><span class="ali-act-col"><button class="ali-pen" title="编辑" @click="toggle('file_name')"><AliIcon name="pen" fb="✎" /></button><button class="ali-link" @click="reveal">打开模型位置</button></span></div>
        <div class="ali-val">{{ d.file_name }}</div>
        <input class="ali-edit-input" v-model="d.file_name" @keydown.enter="ed = null">
        <p class="ali-hint">保存后，模型、封面、元数据 3 个文件会一起重命名。</p>
      </div>
      <div class="ali-row2">
        <div class="ali-field"><div class="ali-field-top"><span>基础模型</span></div><BasePicker v-model="d.base_model" :table="table" @add="addBase" /></div>
        <div class="ali-field is-readonly"><div class="ali-field-top"><span>大小</span></div><div class="ali-val">{{ fmtSize(item.size) }}</div></div>
      </div>
      <div v-if="kind === 'lora'" class="ali-field" :class="{ 'is-editing': ed === 'triggers' }">
        <div class="ali-field-top is-tall"><span>触发词</span><span class="ali-act-col"><button class="ali-pen" title="编辑" @click="toggle('triggers')"><AliIcon name="pen" fb="✎" /></button><button class="ali-link" :disabled="pulling" title="只从 CivitAI 取触发词，不会改动其它内容" @click="pull">{{ pulling ? '拉取中…' : '拉取触发词' }}</button></span></div>
        <div class="ali-val ali-tags">
          <span v-for="w in words" :key="w" class="ali-tag" title="点击复制" @click="copyText(w)">{{ w }} <span v-html="COPY_ICON" style="display:inline-flex"></span></span>
          <span v-if="!words.length" class="is-muted">没有触发词，可点右上角的笔手动添加，或点「拉取触发词」</span>
        </div>
        <input class="ali-edit-input" v-model="d.triggers" placeholder="多个触发词用逗号分隔">
      </div>
      <div class="ali-field" :class="{ 'is-editing': ed === 'notes' }">
        <div class="ali-field-top"><span>备注 / 提示词</span><span class="ali-field-act"><button class="ali-pen" @click="toggle('notes')"><AliIcon name="pen" fb="✎" /></button></span></div>
        <div class="ali-val" :class="{ 'is-muted': !d.notes }" style="white-space:pre-wrap">{{ d.notes || '暂无备注' }}</div>
        <textarea class="ali-edit-input" rows="4" v-model="d.notes"></textarea>
      </div>
    </div>

    <div v-else class="ali-modal-body ali-vers">
      <div v-if="!rows.length" class="ali-vers-empty">
        <p>{{ checked ? 'CivitAI 上没有读到版本列表。' : '还没有这个模型的 CivitAI 版本数据。' }}</p>
        <button class="ali-btn is-sm" :disabled="checking || !item.model_id" :title="item.model_id ? '' : '请先对模型执行「刷新 CivitAI 数据」'" @click="check">{{ checking ? '检查中…' : '检查更新' }}</button>
      </div>
      <article v-for="v in rows" :key="v.id" class="ali-ver" :class="{ 'is-cur': v.current }">
        <div class="ali-ver-img"><img v-if="v.current && cover" :src="cover" alt=""><span v-else>无预览</span></div>
        <div class="ali-ver-main">
          <div class="ali-ver-name"><span>{{ v.name || ('版本 ' + v.id) }}</span><button type="button" class="ali-ver-ext" title="打开这个版本的发布页" @click="openUrl(pageUrl(v))" v-html="EXT"></button></div>
          <div class="ali-ver-tags">
            <span v-if="v.newer && !v.ignored" class="ali-status is-new">较新的版本</span>
            <span v-if="v.ignored" class="ali-status">已忽略</span>
            <span v-if="v.current" class="ali-status is-cur">已打开版本</span>
            <span v-if="v.local" class="ali-status is-ok">已在库中</span>
            <span v-if="v.ea" class="ali-status is-miss">早期访问</span>
          </div>
          <div class="ali-ver-meta">{{ v.base || '—' }} · {{ fmtDate(v.published) }} · {{ v.size ? fmtSize(v.size) : '—' }}</div>
        </div>
        <div class="ali-ver-act">
          <button v-if="!v.local" class="ali-btn is-primary" @click="openUrl(pageUrl(v))">去仓库下载</button>
          <button v-else class="ali-btn" @click="openUrl(pageUrl(v))">查看发布页</button>
          <button v-if="v.newer || v.ignored" class="ali-btn" :disabled="ignoring === v.id" @click="ignore(v)">{{ v.ignored ? '取消忽略' : '忽略此更新' }}</button>
        </div>
      </article>
      <p v-if="rows.length && missSize" class="ali-hint">部分版本的大小还没有记录，在管理页点「检查更新」后会显示。</p>
    </div>

    <footer v-if="cur === 'params'" class="ali-modal-foot"><button class="ali-btn" @click="$emit('close')">取消</button><button class="ali-btn is-on" :disabled="busy" @click="save">保存</button></footer>
  </section></div></Teleport>`,
});

// 样本详情面板：点击样本卡片后，在卡片旁边弹出（没有蒙版）。样本是存下来的记忆数据，所以参数只读；
// 唯一能编辑的是名称和提示词（点「编辑」）。点 ✕ / 点面板外面 / 按 Esc 关闭。
const PARAMS = [['seed', 'Seed(种子)'], ['steps', 'Steps(步数)'], ['cfg', 'CFG(提示词相关性)'], ['sampler', 'Sampler(采样器)'], ['scheduler', 'Scheduler(调度器)'], ['denoise', 'Denoise(重绘幅度)'], ['size', 'Size(尺寸)']];

export const SamplePanel = defineComponent({
  props: { sample: Object, anchor: Object },   // anchor = 被点击卡片的 {left, top, right, bottom}
  emits: ['close', 'saved', 'send'],
  setup(props, { emit }) {
    const el = ref(null), pos = reactive({ x: 0, y: 0, ready: false });
    const editing = ref(false), busy = ref(false);
    const d = reactive({ name: '', prompt: '', negative: '' });
    const gen = computed(() => props.sample.gen || {});
    const view = computed(() => props.sample.view || { models: [], loras: [] });
    const reset = () => { d.name = props.sample.name; d.prompt = gen.value.prompt || ''; d.negative = gen.value.negative || ''; };
    reset();
    watch(() => props.sample, () => { if (!editing.value) reset(); });

    // 只要文件名（view 里的 title 已经去掉了路径和扩展名）；没有记录就显示「—」
    const rows = (list, lora) => (list.length ? list.map((x) => ({ name: x.name, title: x.title, local: x.local, w: lora ? x.strength : undefined })) : [{ title: '—', none: true }]);
    const modelRows = computed(() => rows(view.value.models, false));
    const loraRows = computed(() => rows(view.value.loras, true));
    const canSend = computed(() => !!(props.sample.state && (props.sample.state.models || []).length));
    const val = (k) => {
      const g = gen.value;
      if (k === 'size') return g.size && g.size.length ? g.size.join('×') : '—';
      const v = (g.params || {})[k];
      return v === undefined || v === null || v === '' ? '—' : v;
    };

    const place = async () => {  // 优先放卡片右边，放不下放左边，再不行就夹在屏幕里
      await nextTick();
      const p = el.value, a = props.anchor;
      if (!p || !a) return;
      const W = p.offsetWidth, H = p.offsetHeight, gap = 10, m = 8;
      let x = a.right + gap;
      if (x + W > innerWidth - m) x = a.left - gap - W;
      if (x < m) x = Math.max(m, Math.min(a.left, innerWidth - W - m));
      pos.x = x; pos.y = Math.max(m, Math.min(a.top, innerHeight - H - m)); pos.ready = true;
    };
    const away = (e) => {
      const t = e.target;
      if (el.value && el.value.contains(t)) return;
      if (t.closest && t.closest('.ali-card, .ali-menu, .ali-mask')) return;  // 点卡片由卡片自己切换；菜单 / 确认框不算「点外面」
      emit('close');
    };
    const wheel = (e) => { if (!el.value || !el.value.contains(e.target)) emit('close'); };  // 滚动列表 / 缩放画布时位置会错开，直接收起
    const key = (e) => { if (e.key === 'Escape') emit('close'); };
    let ro;
    onMounted(() => {
      place();
      ro = new ResizeObserver(place); ro.observe(el.value);
      addEventListener('pointerdown', away, true); addEventListener('wheel', wheel, { capture: true, passive: true });
      addEventListener('keydown', key, true); addEventListener('resize', place);
    });
    onBeforeUnmount(() => {
      ro && ro.disconnect();
      removeEventListener('pointerdown', away, true); removeEventListener('wheel', wheel, true);
      removeEventListener('keydown', key, true); removeEventListener('resize', place);
    });

    const copy = (t) => (t ? copyText(t) : toast('没有内容可复制', 'err'));
    const cancel = () => { editing.value = false; reset(); };
    const save = async () => {
      if (!d.name.trim()) return toast('名称不能为空', 'err');
      busy.value = true;
      try {
        const r = await post('sample_update', { id: props.sample.id, patch: { name: d.name, gen: { prompt: d.prompt, negative: d.negative } } });
        editing.value = false; emit('saved', r.item);
      } catch (e) { toast(e.message, 'err'); } finally { busy.value = false; }
    };
    return { el, pos, d, editing, busy, modelRows, loraRows, canSend, val, copy, cancel, save, PARAMS };
  },
  template: `<Teleport to="body"><section ref="el" class="ali-pop" data-kind="sample" role="dialog" :style="{ left: pos.x + 'px', top: pos.y + 'px', visibility: pos.ready ? 'visible' : 'hidden' }" @contextmenu.prevent @wheel.stop @keydown.stop>
    <header class="ali-pop-head">
      <input v-if="editing" class="ali-pop-name" v-model="d.name" placeholder="样本名称" @keydown.enter="save">
      <h2 v-else class="ali-pop-title" :title="d.name">{{ d.name }}</h2>
      <button class="ali-close" title="关闭" @click="$emit('close')">✕</button>
    </header>
    <div class="ali-pop-body">
      <div class="ali-pop-sec">
        <div class="ali-pop-bar"><span class="ali-pop-label">正向提示词：</span>
          <span class="ali-pop-acts">
            <template v-if="!editing">
              <button class="ali-btn" :disabled="!canSend" :title="canSend ? '' : '这个样本没有记录节点里选的模型，无法还原'" @click="$emit('send', sample)">使用样本</button>
              <button class="ali-btn" @click="editing = true">编辑</button>
              <button class="ali-btn is-cur" @click="copy(d.prompt)">复制</button>
            </template>
            <template v-else><button class="ali-btn" @click="cancel">取消</button><button class="ali-btn is-cur" :disabled="busy" @click="save">保存</button></template>
          </span></div>
        <textarea v-if="editing" class="ali-pop-box ali-pop-edit" rows="8" v-model="d.prompt" placeholder="正向提示词"></textarea>
        <div v-else class="ali-pop-box" :class="{ 'is-muted': !d.prompt }">{{ d.prompt || '没有读到提示词，可点「编辑」手动填写' }}</div>
      </div>
      <div v-if="editing || d.negative" class="ali-pop-sec">
        <div class="ali-pop-bar"><span class="ali-pop-label">负向提示词：</span><span class="ali-pop-acts"><button v-if="!editing" class="ali-btn is-cur" @click="copy(d.negative)">复制</button></span></div>
        <textarea v-if="editing" class="ali-pop-box ali-pop-edit" rows="4" v-model="d.negative" placeholder="负向提示词（没有可留空）"></textarea>
        <div v-else class="ali-pop-box">{{ d.negative }}</div>
      </div>
      <div class="ali-pop-info">
        <div v-for="(m, i) in modelRows" :key="'m' + i" class="ali-pop-row"><span class="ali-pop-k">{{ i === 0 ? '使用的大模型：' : '' }}</span><span class="ali-pop-v" :title="m.name">{{ m.title }}</span><span v-if="!m.none" class="ali-status" :class="m.local ? 'is-ok' : 'is-miss'">{{ m.local ? '本地有' : '本地没有' }}</span></div>
        <div v-for="(m, i) in loraRows" :key="'l' + i" class="ali-pop-row"><span class="ali-pop-k">{{ i === 0 ? '使用的LoRA：' : '' }}</span><span class="ali-pop-v" :title="m.name">{{ m.title }}<small v-if="m.w !== undefined"> ({{ m.w }})</small></span><span v-if="!m.none" class="ali-status" :class="m.local ? 'is-ok' : 'is-miss'">{{ m.local ? '本地有' : '本地没有' }}</span></div>
      </div>
      <div class="ali-pop-params"><span v-for="[k, label] in PARAMS" :key="k" class="ali-pop-p"><b>{{ label }}：</b>{{ val(k) }}</span></div>
    </div>
  </section></Teleport>`,
});

// 从工作流输出图里选一张做封面 / 样本封面
export const ImagePicker = defineComponent({
  props: { images: Array },
  emits: ['pick', 'close'],
  setup() { return { url: (i) => `/view?filename=${encodeURIComponent(i.filename)}&subfolder=${encodeURIComponent(i.subfolder || '')}&type=${i.type || 'output'}` }; },
  template: `<Teleport to="body"><div class="ali-mask is-open" @mousedown.self="$emit('close')"><section class="ali-modal" style="width:min(640px,100%)">
    <header class="ali-modal-head"><h2 class="ali-modal-title">选择一张输出图作为封面</h2><button class="ali-close" @click="$emit('close')">✕</button></header>
    <div class="ali-pick-grid"><img v-for="(i, n) in images" :key="n" :src="url(i)" @click="$emit('pick', i)"></div>
  </section></div></Teleport>`,
});
