// 共用数据层与小工具（后台页面和画布节点都用）
import { reactive } from './vue.esm-browser.prod.js';

export const DTYPES = ['default', 'fp8_e4m3fn', 'fp8_e4m3fn_fast', 'fp8_e5m2'];

const json = async (r) => {
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || r.statusText);
  return d;
};
export const get = (p) => fetch('/alili/api/' + p).then(json);
export const post = (p, body) => fetch('/alili/api/' + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(json);
export const del = (p) => fetch('/alili/api/' + p, { method: 'DELETE' }).then(json);

export const coverUrl = (it) => (it && it.cover ? `/alili/api/cover?id=${encodeURIComponent(it.id)}&v=${it.cover_v || 0}` : '');
export const sampleCover = (s) => (s.cover ? `/alili/api/sample_cover?id=${s.id}` : '');
export const fmtSize = (n) => (n >= 2 ** 30 ? (n / 2 ** 30).toFixed(2) + ' GB' : (n / 2 ** 20).toFixed(1) + ' MB');

// 节点里保存的卡片快照（只带显示和加载需要的字段）
export const snap = (it, extra = {}) => ({
  id: it.id, key: it.key, name: it.name, title: it.title, version: it.version, family: it.family, badge: it.badge,
  base_model: it.base_model, cover: it.cover, cover_v: it.cover_v, triggers: it.triggers || [], file_name: it.file_name,
  update: !!it.update, latest: it.latest || null, ...extra,
});

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); }
  catch { const t = Object.assign(document.createElement('textarea'), { value: text }); document.body.append(t); t.select(); document.execCommand('copy'); t.remove(); }
  toast('已复制', 'ok');
}

export function toast(msg, kind = '') {
  let box = document.querySelector('.ali-toasts');
  if (!box) { box = document.createElement('div'); box.className = 'ali-toasts'; document.body.append(box); }
  const el = Object.assign(document.createElement('div'), { className: 'ali-toast ' + (kind ? 'is-' + kind : ''), textContent: msg });
  box.append(el);
  setTimeout(() => el.remove(), 2800);
}

export function confirmBox({ title, body, ok = '确定', danger = false }) {
  return new Promise((resolve) => {
    const mask = document.createElement('div');
    mask.className = 'ali-mask is-open';
    mask.innerHTML = `<section class="ali-modal ali-confirm" role="alertdialog"><header class="ali-modal-head"><h2 class="ali-modal-title"></h2></header><p></p>
      <footer class="ali-modal-foot"><button class="ali-btn" data-v="0">取消</button><button class="ali-btn ${danger ? 'is-danger' : 'is-on'}" data-v="1"></button></footer></section>`;
    mask.querySelector('h2').textContent = title;
    mask.querySelector('p').textContent = body;
    mask.querySelector('[data-v="1"]').textContent = ok;
    const done = (v) => { mask.remove(); resolve(v); };
    mask.addEventListener('mousedown', (e) => { if (e.target === mask) done(false); });
    mask.addEventListener('click', (e) => { const b = e.target.closest('[data-v]'); if (b) done(b.dataset.v === '1'); });
    document.body.append(mask);
  });
}

export function pickFile(accept = 'image/*') {
  return new Promise((resolve) => {
    const i = Object.assign(document.createElement('input'), { type: 'file', accept });
    i.onchange = () => resolve(i.files[0] || null);
    i.click();
  });
}

export async function uploadCover(id, file) {
  const fd = new FormData();
  fd.append('id', id);
  fd.append('file', file);
  return json(await fetch('/alili/api/cover', { method: 'POST', body: fd }));
}

// 后台页面用：直连 ComfyUI 的 WebSocket，收 alili.* 事件
export function connectWS(onMessage) {
  const open = () => {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?clientId=alili-${Math.random().toString(36).slice(2)}`);
    ws.onmessage = (e) => { if (typeof e.data !== 'string') return; try { const m = JSON.parse(e.data); if (m.type && m.type.startsWith('alili.')) onMessage(m.type, m.data); } catch {} };
    ws.onclose = () => setTimeout(open, 2000);
    ws.onopen = () => post('send', { mode: 'hello' }).catch(() => {});  // 让节点回报当前选择
  };
  open();
}

// ───────────── 图标：文件放在 Alili-Manager/images/svg/，缺哪个就用文字符号兜底 ─────────────
// 每个图标可以有几个备用文件名，按顺序找第一个存在的
const ICON_ALIAS = {
  edit: ['edit', 'pen'], pen: ['pen', 'edit'],
  star: ['star', 'star-outline', 'star-empty'], starOn: ['star-fill', 'star-filled', 'star-solid'],
  settings: ['settings', 'gear'], gear: ['settings', 'gear'],   // 齿轮：优先用 settings.svg，没有再找 gear.svg
};
export const icons = reactive({ set: {} });
export const iconUrl = (name) => {
  const hit = (ICON_ALIAS[name] || [name]).find((n) => icons.set[n]);
  return hit ? `/alili/images/svg/${hit}.svg` : '';
};
export const loadIcons = async () => { try { icons.set = await get('icons'); } catch {} };
