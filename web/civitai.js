// 前端的 CivitAI 功能：单张拉取、批量拉取、检查更新 + 进度条状态（对应后端 civitai.py）
// 批量任务由网页逐个驱动：一次只发一个请求，等结果回来再发下一个。所以关掉页面 / 刷新就停，点进度条上的 ✕ 也停（做完手头这一个）。
import { reactive } from './vue.esm-browser.prod.js';
import { post, toast, confirmBox } from './core.js';

// 进度条状态：交给 <AliProgress :job="job" @cancel="cancelJob" /> 显示
export const job = reactive({ show: false, running: false, title: '', kind: 'model', done: 0, total: 0, state: 'run', cancel: false });
let hideTimer = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const begin = (title, kind, total) => { clearTimeout(hideTimer); Object.assign(job, { show: true, running: true, title, kind, done: 0, total, state: 'run', cancel: false }); };
const finish = (state, title, hold) => { job.running = false; job.state = state; job.title = title; hideTimer = setTimeout(() => { job.show = false; }, hold); };
export const cancelJob = () => { if (job.running) job.cancel = true; };
const busy = () => { if (job.running) { toast('已经有任务在进行中，请等它结束或点进度条上的 ✕ 取消', 'err'); return true; } return false; };

// 拉取一张：改过内容会先弹确认，确认后覆盖（删除本地封面和 metadata.json 后重新生成）。返回 { item } / { skipped } / { error }
async function syncOne(id) {
  try {
    let r = await post('civitai_refresh', { id });
    if (r.need_confirm) {
      const ok = await confirmBox({
        title: '发现自定义修改', danger: true, ok: '覆盖并同步',
        body: `你修改过：${r.changes.join('、')}\n\n同步后会覆盖自定义封面与内容：本地封面和 metadata.json 会被删除，再用 CivitAI 的数据重新生成（收藏和拉黑状态保留）。`,
      });
      if (!ok) return { skipped: true };
      r = await post('civitai_refresh', { id, force: true });
    }
    return { item: r.item };
  } catch (e) { return { error: e.message }; }
}

// 单张：没有进度条，用提示
export async function syncCivitai(id) {
  toast('正在同步 CivitAI…');
  const r = await syncOne(id);
  if (r.item) toast('已同步 CivitAI 数据', 'ok'); else if (r.error) toast(r.error, 'err');
  return r.item || null;
}

// 批量拉取（框选后右键）：upsert(item) 用来刷新卡片
export async function syncMany(items, kind, upsert) {
  if (busy() || !items.length) return;
  begin('拉取 CivitAI 数据', kind, items.length);
  let ok = 0, failed = 0, skipped = 0, rate = false;
  for (const it of items) {
    if (job.cancel) break;
    const r = await syncOne(it.id);
    if (r.item) { upsert(r.item); ok++; } else if (r.skipped) skipped++; else failed++;
    job.done++;
    if (r.error && r.error.includes('限流')) { rate = true; break; }   // 被限流了，继续请求只会一直失败
  }
  const sum = `成功 ${ok}` + (failed ? `，失败 ${failed}` : '') + (skipped ? `，跳过 ${skipped}` : '');
  if (job.cancel) { finish('cancel', `已取消 ${job.done}/${job.total}`, 1800); toast(`已取消：${sum}`); }
  else if (rate) { finish('limit', 'CivitAI 限流，已停止', 3500); toast(`CivitAI 请求太频繁，已停止：${sum}。请稍后再试`, 'err'); }
  else { finish('done', '拉取完成', 2500); toast(`拉取完成：${sum}（共 ${job.total} 个）`, failed ? 'err' : 'ok'); }
}

// 检查更新（页面上的「检查更新」按钮）：items = 当前分类的全部卡片
export async function checkUpdates(items, kind, upsert) {
  if (busy()) return;
  const cand = items.filter((i) => i.model_id && !i.exclude);
  const skipped = items.length - cand.length;
  if (!cand.length) return toast('没有可检查的模型：请先对模型执行「刷新 CivitAI 数据」', 'err');
  const groups = new Map();   // 同一个 CivitAI 模型（多个文件 / 版本）放一组，每组只请求一次
  for (const i of cand) { if (!groups.has(i.model_id)) groups.set(i.model_id, []); groups.get(i.model_id).push(i.id); }
  begin('检查更新', kind, cand.length);
  let found = 0, failed = 0, rate = false, n = 0;
  for (const ids of groups.values()) {
    if (job.cancel) break;
    try {
      const r = await post('check_update', { ids });
      r.items.forEach((it) => upsert(it));
      found += r.found; failed += r.failed;
      if (r.stopped) { rate = true; job.done += ids.length; break; }
    } catch (e) { failed += ids.length; }
    job.done += ids.length;
    if (++n < groups.size) await sleep(250);   // 请求之间留一点间隔，别把 CivitAI 打到限流
  }
  const sum = `${found} 个有更新` + (failed ? `，${failed} 个失败` : '') + (skipped ? `，${skipped} 个没有 CivitAI 数据已跳过` : '');
  if (job.cancel) { finish('cancel', `已取消 ${job.done}/${job.total}`, 1800); toast(`已取消：已检查的里面 ${sum}`); }
  else if (rate) { finish('limit', 'CivitAI 限流，已停止', 3500); toast(`CivitAI 限流，已停止：${sum}。请稍后再试`, 'err'); }
  else { finish('done', '检查完成', 2500); toast(`检查完成：${sum}（共 ${job.total} 个）`, failed ? 'err' : 'ok'); }
}
