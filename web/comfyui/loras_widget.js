import { app } from "../../scripts/app.js";
import { createToggle, createArrowButton, createDragHandle, updateEntrySelection, createExpandButton, updateExpandButtonState, createLockButton, updateLockButtonState } from "./loras_widget_components.js";
import { 
  parseLoraValue, 
  formatLoraValue, 
  shouldShowClipEntry, 
  syncClipStrengthIfCollapsed,
  getAvailableLoras,
  getAvailableLorasSync,
  isLoraNameAvailable,
  onLibraryChanged
} from "./loras_widget_utils.js";
import { initDrag, createContextMenu, initHeaderDrag, initReorderDrag, handleKeyboardNavigation } from "./loras_widget_events.js";
import { forwardMiddleMouseToCanvas, forwardWheelToCanvas, enableListWheelScroll, updateDownstreamLoaders } from "./utils.js";
import { applySelectionHighlight } from "./trigger_word_highlight.js";
import { updateConnectedLoraInfoNodes } from "./lora_info.js";
import { PreviewTooltip } from "./preview_tooltip.js";
import { ensureLmStyles } from "./lm_styles_loader.js";
import { getStrengthStepPreference } from "./settings.js";

// 1. 严格对齐 uiHelpers.js 的 ensureRelativeModelPath：把本地绝对路径转为 ComfyUI 相对路径
async function ensureRelativeModelPath(modelPath) {
  if (!modelPath) return "";
  const isAbs = modelPath.startsWith('/') || modelPath.startsWith('\\') || /^[a-zA-Z]:[\\/]/.test(modelPath);
  if (!isAbs) return modelPath;
  const fileName = modelPath.split(/[/\\]/).pop();
  if (!fileName) return modelPath;
  const searchTerm = fileName.replace(/\.(safetensors|ckpt|pt|bin)$/i, '');
  try {
    const res = await fetch(`/api/lm/checkpoints/relative-paths?search=${encodeURIComponent(searchTerm)}&limit=10`);
    if (res.ok) {
      const data = await res.json();
      const relativePaths = Array.isArray(data?.relative_paths) ? data.relative_paths : [];
      const exactMatch = relativePaths.find(p => p.endsWith(fileName));
      return exactMatch || relativePaths[0] || modelPath;
    }
  } catch (e) {}
  return modelPath;
}

// 严格对齐 uiHelpers.js：带节点启用状态过滤 + 多节点弹窗选择
async function sendModelToWorkflow(model, mouseEvent) {
  const modelPath = model.file_path || model.file_name;
  if (!modelPath) return;

  const relativePath = await ensureRelativeModelPath(modelPath);

  // 1. 获取工作流节点，严格过滤 node.mode === 0 (排除已关闭、Mute 或 Bypass 的节点)
  const graph = app.graph;
  if (!graph || !graph._nodes) return;

  // 收集所有处于开启状态、且带有 unet_name 或 ckpt_name 的加载器
  const activeLoaders = graph._nodes.filter(n => {
    // 检查节点是否启用 (0 = 正常启用, 2 = 停用/Mute, 4 = 旁路/Bypass)
    const isEnabled = (n.mode === undefined || n.mode === 0);
    if (!isEnabled) return false;

    // 检查是否包含目标 widget
    return n.widgets?.some(w => w.name === "unet_name" || w.name === "ckpt_name");
  });

  // 分支 A: 如果全部都关闭了，拦截并提示，绝对不乱发
  if (activeLoaders.length === 0) {
    alert("当前工作流中所有加载器均已关闭或停用，无法发送！");
    return;
  }

  // 统一的真实下发动作
  const dispatchToNode = (targetNode) => {
    const targetWidget = targetNode.widgets?.find(w => w.name === "unet_name" || w.name === "ckpt_name");
    if (!targetWidget) return;

    // 1. 前端直接写入正版相对路径并触发回调
    targetWidget.value = relativePath;
    targetNode.onWidgetChanged?.(targetWidget.name, relativePath, targetWidget.value, targetWidget);
    if (typeof targetWidget.callback === 'function') targetWidget.callback(relativePath);

    // 2. 🎯 清除红框报错状态
    targetNode.has_errors = false;

    // 3. 后端接口同步与画布刷新
    fetch('/api/lm/update-node-widget', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        widget_name: targetWidget.name,
        value: relativePath,
        node_ids: [{ node_id: targetNode.id, graph_id: null }]
      })
    }).catch(() => {});

    if (window.app?.canvas) window.app.canvas.setDirty(true, true);
  };

  // 分支 B: 如果只开启了 1 个，直接静默发给这唯一开启的节点
  if (activeLoaders.length === 1) {
    dispatchToNode(activeLoaders[0]);
    return;
  }

  // 分支 C: 开启的节点 >= 2 个，弹出选择器，绝不随便盲发
  // 移除已有弹窗
  const oldMenu = document.querySelector('.lm-node-selector-menu');
  if (oldMenu) oldMenu.remove();

  const menu = document.createElement('div');
  menu.className = 'lm-node-selector-menu';
  menu.style.cssText = `
    position: fixed;
    z-index: 100000;
    background: #1e1e24;
    border: 1px solid rgba(255,255,255,0.2);
    border-radius: 8px;
    padding: 6px;
    box-shadow: 0 10px 30px rgba(0,0,0,0.8);
    color: #fff;
    font-size: 12px;
    min-width: 180px;
  `;

  // 标题
  const title = document.createElement('div');
  title.style.cssText = "padding: 4px 8px; color: #888; border-bottom: 1px solid rgba(255,255,255,0.1); margin-bottom: 4px;";
  title.textContent = "替换 Model: 选择目标节点";
  menu.appendChild(title);

  // 逐个生成开启的节点选项
  activeLoaders.forEach(targetNode => {
    const item = document.createElement('div');
    item.style.cssText = "padding: 6px 10px; cursor: pointer; border-radius: 4px; display: flex; align-items: center; gap: 6px;";
    item.innerHTML = `<span>⚙</span><span>#${targetNode.id} ${targetNode.title || targetNode.type}</span>`;
    item.onmouseenter = () => item.style.background = "#0084ff";
    item.onmouseleave = () => item.style.background = "transparent";
    item.onclick = (e) => {
      e.stopPropagation();
      dispatchToNode(targetNode);
      menu.remove();
    };
    menu.appendChild(item);
  });

  // 全部发送选项
  const allItem = document.createElement('div');
  allItem.style.cssText = "padding: 6px 10px; cursor: pointer; border-radius: 4px; color: #00d2ff; border-top: 1px solid rgba(255,255,255,0.1); margin-top: 4px;";
  allItem.innerHTML = "<span>📡 全部发送</span>";
  allItem.onmouseenter = () => allItem.style.background = "rgba(0,210,255,0.2)";
  allItem.onmouseleave = () => allItem.style.background = "transparent";
  allItem.onclick = (e) => {
    e.stopPropagation();
    activeLoaders.forEach(dispatchToNode);
    menu.remove();
  };
  menu.appendChild(allItem);

  // 定位在鼠标点击位置
  const posX = mouseEvent ? mouseEvent.clientX : window.innerWidth / 2;
  const posY = mouseEvent ? mouseEvent.clientY : window.innerHeight / 2;
  menu.style.left = `${posX + 10}px`;
  menu.style.top = `${posY + 10}px`;

  document.body.appendChild(menu);

  // 点击外部关闭
  const closeMenu = (e) => {
    if (!menu.contains(e.target)) {
      menu.remove();
      document.removeEventListener('click', closeMenu);
    }
  };
  setTimeout(() => document.addEventListener('click', closeMenu), 0);
}

// ── 全局统一：忽略大小写 + 所有非字母数字字符，只留纯字母数字比较 ──
const normalize = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

// ── 1. CLIP & VAE 自动匹配表 ──
const CLIP_MAP = {
  "Anima":      { clip: "qwen_3_06b_base.safetensors", type: "stable_diffusion", vae: "qwen_image_vae.safetensors" },
  "ERNIE":      { clip: "ministral-3-3b.safetensors", type: "ernie_image", vae: "flux2-vae.safetensors" },
  "flux":       { clip: "umt5_xxl_fp8_e4m3fn_scaled.safetensors", clip2: "clip_l.safetensors", type: "flux", vae: "ae.safetensors" },  
  "flux2":      { clip: "mistral_3_small_flux2_fp8.safetensors", type: "flux2", vae: "flux2-vae.safetensors" },  
  "Klein-4B":   { clip: "qwen_3_4b.safetensors", type: "flux2", vae: "flux2-vae.safetensors" },
  "Klein-9B":   { clip: "qwen3vl_8b_fp8_scaled.safetensors", type: "flux2", vae: "flux2-vae.safetensors" },
  "Ideogram4":  { clip: "qwen3vl_8b_fp8_scaled.safetensors", type: "ideogram4", vae: "flux2-vae.safetensors" },
  "krea2":      { clip: "qwen3vl_4b_bf16.safetensors", type: "krea2", vae: "qwen_image_vae.safetensors" },  
  "LTX2.3":    { clip: "gemma_3_12B_it_fp8_e4m3fn.safetensors", type: "ltxv", vae: "ltx-2.3-video-vae-bf16.safetensors", vae2: "ltx-2.3-audio-vae-bf16.safetensors" },
  "LTX2.5":    { clip: "gemma4-12b-with-proj-ltx-2.5-bf16.safetensors", type: "ltxv", vae: "ltx-2.5-video-vae-bf16.safetensors", vae2: "ltx-2.5-audio-vae-bf16.safetensors" },  
  "MiniMax-H3": { clip: "qwen3vl_32b_minimax_h3_int8_convrot.safetensors", type: "minimax", vae: "minimax_h3_video_vae_fp16.safetensors", vae2: "minimax_h3_audio_vae_fp32.safetensors" },  
  "Qwen-Image": { clip: "qwen_2.5_vl_7b_fp8_scaled.safetensors", type: "qwen_image", vae: "qwen_image_vae.safetensors" },
  "sdxl":       { clip: "clip_l.safetensors", clip2: "clip_g.safetensors", type: "sdxl", vae: "sdxl_vae.safetensors" },  
  "Z-image":     { clip: "qwen_3_4b.safetensors", type: "lumina2", vae: "ae.safetensors" },
};

// ── 2. 完全照抄大模型逻辑：活性过滤 + 通配识别 + 单节点静默/多节点选择 ──
async function sendClipToWorkflow(model, mouseEvent) {
  // 智能识别大模型家族归属
  const rawClean = normalize(`${model.folder || ''} ${model.base_model || ''} ${model.file_name || ''}`);
  const matchedKey = Object.keys(CLIP_MAP)
    .sort((a, b) => b.length - a.length) // 👈 让长的词（flux2）排在短的词（flux）前面先判断
    .find(k => rawClean.includes(normalize(k)));
  if (!matchedKey) return; // 未命中映射表，静默跳过，不影响大模型

  const clipConf = CLIP_MAP[matchedKey];
  const graph = app.graph;
  if (!graph || !graph._nodes) return;

  // 🎯 核心破局：当前模型要双 CLIP 还是单 CLIP？
  const isDualModel = Boolean(clipConf.clip2);

  const activeClipLoaders = graph._nodes.filter(n => {
    const isEnabled = (n.mode === undefined || n.mode === 0);
    if (!isEnabled) return false;

    // 判断节点本身是不是双 CLIP 节点（看它身上有没有第 2 个模型的控件）
    const isDualNode = n.widgets?.some(w => /^(clip_name2|clip2)$/i.test(w.name));

    // 各找各妈：双模型只找双节点，单模型只找单节点！
    if (isDualModel) {
      return isDualNode;
    } else {
      return !isDualNode && n.widgets?.some(w => /^(clip_name|clip_name1|clip)$/i.test(w.name));
    }
  });

  if (activeClipLoaders.length === 0) return; // 没开启的 CLIP 加载器则不动作

  // 统一的属性注入执行动作（自动适应单 CLIP、双 CLIP、类型与设备）
  const dispatchToClipNode = (targetNode) => {
    const updateWidget = (nameMatchRegex, val) => {
      if (!val) return;
      const w = targetNode.widgets?.find(w => nameMatchRegex.test(w.name));
      if (!w) return;

      // 🎯 核心修复：自动匹配下拉列表 (options.values) 中的真实名字，消灭下划线和路径差异
      let realVal = val;
      const candidates = w.options?.values;
      if (Array.isArray(candidates) && candidates.length > 0) {
        const clean = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
        const targetClean = clean(val.split(/[/\\]/).pop().replace(/\.(safetensors|pt|ckpt|bin)$/i, ''));
        const matched = candidates.find(item => item === val)
                     || candidates.find(item => clean(item).includes(targetClean) || targetClean.includes(clean(item)));
        if (matched) realVal = matched;
      }

      w.value = realVal;
      targetNode.onWidgetChanged?.(w.name, realVal, w.value, w);
      if (typeof w.callback === 'function') w.callback(realVal);
      fetch('/api/lm/update-node-widget', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          widget_name: w.name,
          value: realVal,
          node_ids: [{ node_id: targetNode.id, graph_id: null }]
        })
      }).catch(() => {});
    };

    // 🎯 第 1 行：通配 clip_name1 / clip1 / clip_name
    updateWidget(/^(clip_name1|clip1|clip_name|clip)$/i, clipConf.clip);

    // 🎯 第 2 行：有 clip2 就填 clip2；单模型没配 clip2 就自动填充同一个，避免残留！
    const secondClip = clipConf.clip2 || clipConf.clip;
    updateWidget(/^(clip_name2|clip2|clip_2)$/i, secondClip);
    updateWidget(/^(type|类型)$/i, clipConf.type);
    updateWidget(/^(device|设备)$/i, clipConf.device);

    // ⚡ 核心黑科技：自动物理飞线（把闲置 CLIP 节点的连线瞬间拔过来！）
    const targetSlot = targetNode.outputs?.findIndex(o => o.type === "CLIP" || o.name === "CLIP") ?? 0;
    
    // 找出画布上其它开启、但当前没被选中的 CLIP 节点（比如单选双、或者双选单时的另一个）
    const otherClipNodes = graph._nodes.filter(n => 
      n.id !== targetNode.id && 
      (n.mode === undefined || n.mode === 0) &&
      n.widgets?.some(w => /^(clip_name|clip_name1|clip)$/i.test(w.name))
    );

    otherClipNodes.forEach(otherNode => {
      const otherSlot = otherNode.outputs?.findIndex(o => o.type === "CLIP" || o.name === "CLIP") ?? 0;
      const links = otherNode.outputs?.[otherSlot]?.links;
      if (Array.isArray(links) && links.length > 0) {
        // 浅拷贝一份连线 ID 列表进行安全转移
        [...links].forEach(linkId => {
          const link = graph.links?.[linkId];
          if (!link) return;
          const downstreamNode = graph.getNodeById(link.target_id);
          const downstreamSlot = link.target_slot;
          if (!downstreamNode) return;

          // 1. 从旧节点拔出这根线
          otherNode.disconnectOutput(otherSlot, downstreamNode);
          // 2. 瞬间插到当前激活的目标节点上！
          targetNode.connect(targetSlot, downstreamNode, downstreamSlot);
        });
      }
    });

    if (window.app?.canvas) window.app.canvas.setDirty(true, true);
  };

  // 照抄优先级 2：若只有 1 个开启的 CLIP 加载器，直接静默替换！
  if (activeClipLoaders.length === 1) {
    dispatchToClipNode(activeClipLoaders[0]);
    return;
  }

  // 照抄优先级 3：若有 >= 2 个开启的，弹出目标节点选择菜单
  const oldMenu = document.querySelector('.lm-clip-selector-menu');
  if (oldMenu) oldMenu.remove();

  const menu = document.createElement('div');
  menu.className = 'lm-node-selector-menu lm-clip-selector-menu';
  menu.style.cssText = `
    position: fixed; z-index: 100001; background: #1e1e24; border: 1px solid rgba(0,210,255,0.4);
    border-radius: 8px; padding: 6px; box-shadow: 0 10px 30px rgba(0,0,0,0.8);
    color: #fff; font-size: 12px; min-width: 180px;
  `;

  const title = document.createElement('div');
  title.style.cssText = "padding: 4px 8px; color: #00d2ff; border-bottom: 1px solid rgba(255,255,255,0.1); margin-bottom: 4px;";
  title.textContent = `联动 CLIP (${matchedKey.toUpperCase()}): 选择节点`;
  menu.appendChild(title);

  activeClipLoaders.forEach(targetNode => {
    const item = document.createElement('div');
    item.style.cssText = "padding: 6px 10px; cursor: pointer; border-radius: 4px; display: flex; align-items: center; gap: 6px;";
    item.innerHTML = `<span>📎</span><span>#${targetNode.id} ${targetNode.title || targetNode.type}</span>`;
    item.onmouseenter = () => item.style.background = "#0084ff";
    item.onmouseleave = () => item.style.background = "transparent";
    item.onclick = (e) => {
      e.stopPropagation();
      dispatchToClipNode(targetNode);
      menu.remove();
    };
    menu.appendChild(item);
  });

  const posX = mouseEvent ? mouseEvent.clientX : window.innerWidth / 2;
  const posY = mouseEvent ? mouseEvent.clientY : window.innerHeight / 2;
  menu.style.left = `${posX + 10}px`;
  menu.style.top = `${posY + 10}px`;
  document.body.appendChild(menu);

  const closeMenu = (e) => {
    if (!menu.contains(e.target)) {
      menu.remove();
      document.removeEventListener('click', closeMenu);
    }
  };
  setTimeout(() => document.addEventListener('click', closeMenu), 0);
}

// ── 3. VAE 联动引擎：通配所有 vae_name / vae 节点 ──
async function sendVaeToWorkflow(model, mouseEvent) {
  const rawClean = normalize(`${model.folder || ''} ${model.base_model || ''} ${model.file_name || ''}`);
  const matchedKey = Object.keys(CLIP_MAP)
    .sort((a, b) => b.length - a.length) // 👈 让长的词（flux2）排在短的词（flux）前面先判断
    .find(k => rawClean.includes(normalize(k)));
  if (!matchedKey || !CLIP_MAP[matchedKey].vae) return; // 未配置 VAE 时静默跳过

  const targetVae = CLIP_MAP[matchedKey].vae;
  const targetVae2 = CLIP_MAP[matchedKey].vae2;  
  const graph = app.graph;
  if (!graph || !graph._nodes) return;

  // 照抄优先级 1：过滤已启用的节点，通配所有含 vae_name 或 vae 的加载器
  const activeVaeLoaders = graph._nodes.filter(n => {
    const isEnabled = (n.mode === undefined || n.mode === 0);
    if (!isEnabled) return false;
    return n.widgets?.some(w => /^(vae_name|vae)$/i.test(w.name));
  });

  if (activeVaeLoaders.length === 0) return; // 没开启单独的 VAE 节点则不动作（兼容原生 Checkpoint）

// 统一的 VAE 下发动作（支持视频 VAE / 音频 VAE 分别动态注入）
  const dispatchToVaeNode = (targetNode, currentVaeVal = targetVae) => {
    if (!targetNode || !currentVaeVal) return;
    const w = targetNode.widgets?.find(w => /^(vae_name|vae)$/i.test(w.name));
    if (!w) return;

    // 🎯 自动对齐 VAE 下拉列表（智能匹配传入的具体是哪一个 VAE）
    let realVal = currentVaeVal;
    const candidates = w.options?.values;
    if (Array.isArray(candidates) && candidates.length > 0) {
      const clean = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
      const targetClean = clean(currentVaeVal.split(/[/\\]/).pop().replace(/\.(safetensors|pt|ckpt|bin)$/i, ''));
      const matched = candidates.find(item => item === currentVaeVal)
                   || candidates.find(item => clean(item).includes(targetClean) || targetClean.includes(clean(item)));
      if (matched) realVal = matched;
    }

    w.value = realVal;
    targetNode.onWidgetChanged?.(w.name, realVal, w.value, w);
    if (typeof w.callback === 'function') w.callback(realVal);
    fetch('/api/lm/update-node-widget', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        widget_name: w.name,
        value: realVal,
        node_ids: [{ node_id: targetNode.id, graph_id: null }]
      })
    }).catch(() => {});
    if (window.app?.canvas) window.app.canvas.setDirty(true, true);
  };

// 🎯 核心场景 1：如果配置了 vae2（音频VAE），且正好开着 2 个 VAE 节点，自动定向分发！
  if (targetVae2 && activeVaeLoaders.length === 2) {
    // 找出哪个是音频 VAE 节点（看标题、或者看它连线的目标有没有 audio 关键词）
    const isAudioNode = (n) => {
      const titleMatch = /audio|音频|sound/i.test(n.title || n.type || '');
      if (titleMatch) return true;
      const slot = n.outputs?.findIndex(o => /^(vae)$/i.test(o.type || o.name)) ?? 0;
      const links = n.outputs?.[slot]?.links || [];
      return links.some(linkId => {
        const target = graph.getNodeById(graph.links?.[linkId]?.target_id);
        return /audio|音频/i.test(target?.title || target?.type || '');
      });
    };

    let audioNode = activeVaeLoaders.find(isAudioNode);
    let videoNode = activeVaeLoaders.find(n => n !== audioNode);

    // 保底：若没标标题也没特殊连线，默认第 1 个是视频，第 2 个是音频
    if (!audioNode) {
      videoNode = activeVaeLoaders[0];
      audioNode = activeVaeLoaders[1];
    }

    dispatchToVaeNode(videoNode, targetVae);
    dispatchToVaeNode(audioNode, targetVae2);
    return;
  }

  // 普通场景：单个 VAE 节点直接静默下发
  if (activeVaeLoaders.length === 1) {
    dispatchToVaeNode(activeVaeLoaders[0], targetVae);
    return;
  }

  // 多余冲突节点弹窗（仅在未配 vae2 或节点数不等于 2 时弹出）
  const oldMenu = document.querySelector('.lm-vae-selector-menu');
  if (oldMenu) oldMenu.remove();

  const menu = document.createElement('div');
  menu.className = 'lm-node-selector-menu lm-vae-selector-menu';
  menu.style.cssText = `
    position: fixed; z-index: 100002; background: #1e1e24; border: 1px solid rgba(255,180,0,0.4);
    border-radius: 8px; padding: 6px; box-shadow: 0 10px 30px rgba(0,0,0,0.8);
    color: #fff; font-size: 12px; min-width: 180px;
  `;

  const title = document.createElement('div');
  title.style.cssText = "padding: 4px 8px; color: #ffb400; border-bottom: 1px solid rgba(255,255,255,0.1); margin-bottom: 4px;";
  title.textContent = `联动 VAE (${matchedKey.toUpperCase()}): 选择节点`;
  menu.appendChild(title);

  activeVaeLoaders.forEach(targetNode => {
    const item = document.createElement('div');
    item.style.cssText = "padding: 6px 10px; cursor: pointer; border-radius: 4px; display: flex; align-items: center; gap: 6px;";
    item.innerHTML = `<span>🎨</span><span>#${targetNode.id} ${targetNode.title || targetNode.type}</span>`;
    item.onmouseenter = () => item.style.background = "#ff9900";
    item.onmouseleave = () => item.style.background = "transparent";
    item.onclick = (e) => {
      e.stopPropagation();
      dispatchToVaeNode(targetNode);
      menu.remove();
    };
    menu.appendChild(item);
  });

  const posX = mouseEvent ? mouseEvent.clientX : window.innerWidth / 2;
  const posY = mouseEvent ? mouseEvent.clientY : window.innerHeight / 2;
  menu.style.left = `${posX + 20}px`;
  menu.style.top = `${posY + 20}px`;
  document.body.appendChild(menu);

  const closeMenu = (e) => {
    if (!menu.contains(e.target)) {
      menu.remove();
      document.removeEventListener('click', closeMenu);
    }
  };
  setTimeout(() => document.addEventListener('click', closeMenu), 0);
}

// ── 4. K采样器步数联动引擎：全局巡检机制（有加速保加速，全关才回弹20） ──
function syncStepsToSampler(loraName = null, cardElement = null) {
  const extractSteps = (text) => {
    if (!text) return null;
    const match = text.match(/(?:^|[^a-zA-Z0-9])(\d+)\s*[-_]?\s*(?:steps?|st|步)(?:[^a-zA-Z0-9]|$)/i)
               || text.match(/(?:lightning|turbo)[-_ ]*(\d+)/i);
    if (match) {
      const parsed = parseInt(match[1], 10);
      if (!isNaN(parsed) && parsed > 0 && parsed <= 150) return parsed;
    }
    return null;
  };

  let targetSteps = null;

  // 1. 优先判定当前刚点亮激活的卡片自身是否自带步数（如用户主动切 4 步或 8 步）
  if (loraName) {
    const cardText = `${cardElement?.innerText || ""} ${cardElement?.textContent || ""}`;
    targetSteps = extractSteps(`${loraName} ${cardText}`);
  }

  // 2. 关键保护：如果刚点的是画风卡（无步数）或刚关掉某个卡，全面扫描所有当前处于“激活”状态的卡片
  if (!targetSteps) {
    const activeCards = document.querySelectorAll('.lm-lora-entry[data-active="true"]');
    for (const card of activeCards) {
      const cName = card.dataset.loraName || "";
      const cText = `${cName} ${card.innerText || ""} ${card.textContent || ""}`;
      const found = extractSteps(cText);
      if (found) {
        targetSteps = found; // 保护现场：发现 4 步/8 步依旧处于激活状态，坚决维持！
        break;
      }
    }
  }

  // 3. 只有当全场所有激活的卡片里确实没有任何加速 LoRA 时，才安全回滚至 20 步
  if (!targetSteps) {
    targetSteps = 20;
  }

  const graph = app.graph;
  if (!graph || !graph._nodes) return;

  const activeSamplers = graph._nodes.filter(n => {
    const isEnabled = (n.mode === undefined || n.mode === 0);
    return isEnabled && n.widgets?.some(w => /^(steps|步数)$/i.test(w.name));
  });

  activeSamplers.forEach(targetNode => {
    const w = targetNode.widgets?.find(w => /^(steps|步数)$/i.test(w.name));
    if (!w || w.value === targetSteps) return;

    w.value = targetSteps;
    targetNode.onWidgetChanged?.(w.name, targetSteps, w.value, w);
    if (typeof w.callback === 'function') w.callback(targetSteps);

    fetch('/api/lm/update-node-widget', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        widget_name: w.name,
        value: targetSteps,
        node_ids: [{ node_id: targetNode.id, graph_id: null }]
      })
    }).catch(() => {});
  });

  if (window.app?.canvas) window.app.canvas.setDirty(true, true);
}

// ── 5. 大模型选模步数联动：若 LoRA 未选中加速步数，自动判定为 20 步 ──
function syncStepsOnCkptSelect(widget, modelObj, rawName) {
  const extractSteps = (text) => {
    if (!text) return null;
    const match = text.match(/(?:^|[^a-zA-Z0-9])(\d+)\s*[-_]?\s*(?:steps?|st|步)(?:[^a-zA-Z0-9]|$)/i)
               || text.match(/(?:lightning|turbo)[-_ ]*(\d+)/i);
    if (match) {
      const parsed = parseInt(match[1], 10);
      if (!isNaN(parsed) && parsed > 0 && parsed <= 150) return parsed;
    }
    return null;
  };

  // 1. 检查 LoRA 侧：当前是否有任何已经激活 (active: true) 的步数 LoRA
  const lorasData = parseLoraValue(widget.value);
  const activeLoras = lorasData.filter(l => l.active);
  const hasStepLora = activeLoras.some(l => extractSteps(l.name));
  
  // 核心保护：如果 LoRA 侧正开着加速 LoRA，坚决维持当前步数，绝不改动！
  if (hasStepLora) return;

  // 2. 如果没选加速 LoRA：检测大模型自身是否带加速步数（如 8-step 底模），否则直接判定为 20 步
  const ckptText = `${modelObj?.file_name || ''} ${modelObj?.model_name || ''} ${rawName || ''} ${modelObj?.civitai?.name || ''}`;
  const targetSteps = extractSteps(ckptText) || 20;

  // 3. 执行同步给采样器
  const graph = app.graph;
  if (!graph || !graph._nodes) return;
  const activeSamplers = graph._nodes.filter(n => {
    const isEnabled = (n.mode === undefined || n.mode === 0);
    return isEnabled && n.widgets?.some(w => /^(steps|步数)$/i.test(w.name));
  });

  activeSamplers.forEach(targetNode => {
    const w = targetNode.widgets?.find(w => /^(steps|步数)$/i.test(w.name));
    if (!w || w.value === targetSteps) return;

    w.value = targetSteps;
    targetNode.onWidgetChanged?.(w.name, targetSteps, w.value, w);
    if (typeof w.callback === 'function') w.callback(targetSteps);

    fetch('/api/lm/update-node-widget', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        widget_name: w.name,
        value: targetSteps,
        node_ids: [{ node_id: targetNode.id, graph_id: null }]
      })
    }).catch(() => {});
  });

  if (window.app?.canvas) window.app.canvas.setDirty(true, true);
}

// 自动保存工作流防抖函数（模拟触发 Ctrl+S）
let __lmAutoSaveTimer = null;
function triggerAutoSave() {
  clearTimeout(__lmAutoSaveTimer);
  __lmAutoSaveTimer = setTimeout(() => {
    const evt = new KeyboardEvent('keydown', {
      key: 's',
      code: 'KeyS',
      keyCode: 83,
      which: 83,
      ctrlKey: true,
      bubbles: true,
      cancelable: true
    });
    window.dispatchEvent(evt);
    document.dispatchEvent(evt);
  }, 300);
}

// 核心判定：提取纯语法特征（模型名+权重），卡片点击选中时特征完全一致，绝不触发保存！
let __lastSyntaxKey = "";
function checkSyntaxAndAutoSave(currentData) {
  if (!Array.isArray(currentData)) return;
  const currentKey = currentData.map(l => `${l.name}@${l.strength}@${l.clipStrength}`).join(';');
  if (!__lastSyntaxKey) {
    __lastSyntaxKey = currentKey; // 首次载入初始化，不保存
    return;
  }
  // 只有卡片数量增删、或权重数值修改时才保存
  if (currentKey !== __lastSyntaxKey) {
    __lastSyntaxKey = currentKey;
    triggerAutoSave();
  }
}

export function addLorasWidget(node, name, opts, callback) {
  ensureLmStyles();

  // Create container for loras — search for an empty container already
  // in the DOM first. During undo/redo in ComfyUI Vue render mode,
  // WidgetDOM.vue reuses its component without re-calling
  // mountWidgetElement(), so we must reuse the existing DOM element
  // instead of creating an orphaned replacement.
  let container = null;
  let reuseExisting = false;
  const existingContainers = document.querySelectorAll('.lm-loras-container');
  for (const el of existingContainers) {
    if (el.children.length === 0) {
      container = el;
      reuseExisting = true;
      break;
    }
  }

  if (!container) {
    container = document.createElement("div");
    container.className = "lm-loras-container";
  }

  if (!reuseExisting) {
    forwardMiddleMouseToCanvas(container);
    forwardWheelToCanvas(container);
  }

  // Set initial height using CSS variables approach
  const defaultHeight = 200;

  // Set a fixed minimum height so the node has a reasonable starting size.
  // Adding or removing LoRAs does NOT change the node size — the container
  // scrolls when content exceeds the allocated space.
  container.style.setProperty('--comfy-widget-min-height', `${defaultHeight}px`);

  if (!reuseExisting && typeof LiteGraph !== 'undefined' && LiteGraph.vueNodesMode) {
    container.classList.add('lm-vue-node');
    enableListWheelScroll(container);
  }

  // Check if this is a randomizer node (lock button instead of drag handle)
  const isRandomizerNode = opts?.isRandomizerNode === true;

  // Initialize default value
  const defaultValue = opts?.defaultVal || [];
  const onSelectionChange = typeof opts?.onSelectionChange === "function"
    ? opts.onSelectionChange
    : null;

  // Create preview tooltip instance
  const previewTooltip = new PreviewTooltip({ modelType: "loras" });
  
  // Selection state - only one LoRA can be selected at a time
  let selectedLora = null;
  let currentLorasData = parseLoraValue(defaultValue);
  let lastSelectionKey = "__none__";
  let pendingFocusTarget = null;

  const PREVIEW_SUPPRESSION_AFTER_DRAG_MS = 500;
  let strengthDragActive = false;
  let lastStrengthDragEndAt = 0;

  const shouldSuppressPreview = () => {
    if (strengthDragActive) {
      return true;
    }
    return Date.now() - lastStrengthDragEndAt < PREVIEW_SUPPRESSION_AFTER_DRAG_MS;
  };

  const markStrengthDragStart = () => {
    strengthDragActive = true;
    previewTooltip.hide();
  };

  const markStrengthDragEnd = () => {
    strengthDragActive = false;
    lastStrengthDragEndAt = Date.now();
    previewTooltip.hide();
  };
  
  // Function to select a LoRA
  const buildSelectionPayload = (loraName) => {
    if (!loraName) {
      return null;
    }

    const entry = currentLorasData.find((lora) => lora.name === loraName);
    if (!entry) {
      return null;
    }

    return {
      name: entry.name,
      active: !!entry.active,
      entry: { ...entry },
    };
  };

  const emitSelectionChange = (payload, options = {}) => {
    if (!onSelectionChange) {
      return;
    }

    const key = payload
      ? `${payload.name || ""}|${payload.active ? "1" : "0"}`
      : "__null__";

    if (!options.force && key === lastSelectionKey) {
      return;
    }

    lastSelectionKey = key;
    onSelectionChange(payload);
  };

  const selectLora = (loraName, options = {}) => {
    selectedLora = loraName;
    // Update visual feedback for all entries
    container.querySelectorAll('.lm-lora-entry').forEach(entry => {
      const entryLoraName = entry.dataset.loraName;
      updateEntrySelection(entry, entryLoraName === selectedLora);
    });

    if (!options.silent) {
      emitSelectionChange(buildSelectionPayload(loraName));
    }
  };

  // Mirror ComfyUI's setNodeHasErrors: has_errors is not an auto-tracked
  // litegraph property, so the node:property:changed event must be fired
  // manually for the Vue renderer to pick up the error state.
  //
  // The flag is applied asynchronously (setTimeout 0): applying it during
  // LGraphNode.configure makes ComfyUI's errorNodeWidgets.onConfigure create
  // a fallback UNKNOWN widget for every widgets_values entry, because it
  // treats has_errors as "node definition missing".
  let pendingErrorFlag = null;
  let errorFlagTimer = null;

  const flushErrorFlag = () => {
    errorFlagTimer = null;
    const hasMissing = pendingErrorFlag;
    pendingErrorFlag = null;
    if (typeof hasMissing !== 'boolean') {
      return;
    }
    const oldValue = node.has_errors === true;
    if (oldValue === hasMissing) {
      return;
    }
    node.has_errors = hasMissing;
    if (node.graph) {
      node.graph.trigger('node:property:changed', {
        type: 'node:property:changed',
        nodeId: node.id,
        property: 'has_errors',
        oldValue,
        newValue: hasMissing
      });
      node.graph.setDirtyCanvas(true, true);
    }
  };

  const updateNodeErrorFlag = (hasMissing) => {
    pendingErrorFlag = hasMissing;
    if (errorFlagTimer === null) {
      errorFlagTimer = setTimeout(flushErrorFlag, 0);
    }
  };
  
  // Add keyboard event listener to container
  container.addEventListener('keydown', (e) => {
    if (handleKeyboardNavigation(e, selectedLora, widget, renderLoras, selectLora)) {
      e.stopPropagation();
    }
  });
  
  // Make container focusable for keyboard events
  container.tabIndex = 0;
  
  // Function to render loras from data
  const renderLoras = (value, widget) => {
    // Clear existing content
    while (container.firstChild) {
      container.removeChild(container.firstChild);
    }
    
    // 插入主 TAB 栏
    if (!widget.__activeTab) widget.__activeTab = 'lora';
    container.dataset.activeTab = widget.__activeTab;
    const tabsBar = document.createElement("div");
    tabsBar.className = "lm-main-tabs-bar";
    tabsBar.innerHTML = `
      <div class="lm-tabs-top-row">
        <div class="lm-tab-pill ${widget.__activeTab === 'lora' ? 'active' : ''}" data-tab="lora">
          <span>🎨 风格LoRA</span>
          <span class="lm-tab-count-badge" style="display: none;">0</span>
        </div>
        <div class="lm-tab-pill ${widget.__activeTab === 'ckpt' ? 'active' : ''}" data-tab="ckpt">📦 大模型</div>
      </div>
    `;

    // 动态同步 LoRA 选中数量徽章（0个时不显示）
    const updateLoraTabBadge = () => {
      const badge = tabsBar.querySelector('.lm-tab-count-badge');
      if (!badge) return;
      const count = parseLoraValue(widget.value).filter(l => l.active).length;
      if (count > 0) {
        badge.textContent = count;
        badge.style.display = 'inline-flex';
      } else {
        badge.style.display = 'none';
      }
    };
    updateLoraTabBadge();

    const tabsTopRow = tabsBar.querySelector('.lm-tabs-top-row');
    tabsBar.querySelectorAll('.lm-tab-pill').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const tab = btn.dataset.tab;
        if (widget.__activeTab === tab) return;
        widget.__activeTab = tab;
        renderLoras(widget.value, widget);
      });
    });
    container.appendChild(tabsBar);

    // Parse the loras data
    const lorasData = parseLoraValue(value);
    currentLorasData = lorasData;
    const focusSequence = [];

    const updateWidgetValue = (newValue) => {
      widget.value = newValue;
      if (typeof widget.callback === "function") {
        widget.callback(widget.value);
      }
      // 核心：点击卡片选中时不触发；仅在增删卡片或拖动修改权重时才自动保存
      checkSyntaxAndAutoSave(parseLoraValue(newValue));
    };

    const createFocusEntry = (loraName, type) => {
      const entry = { name: loraName, type };
      focusSequence.push(entry);
      return entry;
    };

    const findFocusEntryIndex = (entry) =>
      focusSequence.findIndex(
        (sequenceEntry) =>
          sequenceEntry?.name === entry?.name && sequenceEntry?.type === entry?.type
      );

    const getAdjacentFocusEntry = (currentEntry, direction) => {
      const currentIndex = findFocusEntryIndex(currentEntry);
      if (currentIndex === -1) return null;
      return focusSequence[currentIndex + direction] || null;
    };

    const queueFocusEntry = (entry) => {
      if (!entry) return false;
      pendingFocusTarget = { ...entry };
      return true;
    };

    const queueFocusAdjacentFrom = (currentEntry, direction) => {
      const targetEntry = getAdjacentFocusEntry(currentEntry, direction);
      return queueFocusEntry(targetEntry);
    };

    const escapeLoraName = (loraName) => {
      const css = (typeof window !== "undefined" && window.CSS) || (typeof globalThis !== "undefined" && globalThis.CSS);
      if (css && typeof css.escape === "function") return css.escape(loraName);
      return loraName.replace(/"|\\/g, "\\$&");
    };

// 🎯 LoRA 与大模型公用拖拽换位 + 自动互换文本框内语法标签
    const bindCardDragAndSwap = (el, cardName, cardType) => {
      el.draggable = true;
      el.addEventListener('dragstart', (e) => {
        if (e.target.closest('input') || e.target.closest('.lm-lora-arrow') || e.target.closest('.lm-card-gear-btn')) {
          e.preventDefault();
          return;
        }
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', JSON.stringify({ name: cardName, type: cardType }));
        el.classList.add('lm-dragging');
      });
      el.addEventListener('dragend', () => el.classList.remove('lm-dragging'));
      el.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
      });
      el.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        let data;
        try { data = JSON.parse(e.dataTransfer.getData('text/plain')); } catch { data = { name: e.dataTransfer.getData('text/plain'), type: cardType }; }
        if (!data?.name || data.name === cardName || data.type !== cardType) return;

        const fromName = data.name;
        const toName = cardName;
        const tw = node.widgets?.find(w => w.name === "text") || node.inputWidget;

        // 1. 调换文本框内的语法位置 (<model:...> 或 <lora:...>)
        if (tw && tw.value) {
          const prefix = cardType === 'ckpt' ? 'model' : 'lora';
          const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const fromM = tw.value.match(new RegExp(`<${prefix}:${esc(fromName)}(?::[^>]*?)?>`, 'i'));
          const toM = tw.value.match(new RegExp(`<${prefix}:${esc(toName)}(?::[^>]*?)?>`, 'i'));
          if (fromM && toM) {
            const fTag = fromM[0], tTag = toM[0];
            const fIdx = tw.value.indexOf(fTag), tIdx = tw.value.indexOf(tTag);
            let val = tw.value.replace(fTag, '___TEMP_LM___');
            val = fIdx < tIdx ? val.replace(tTag, `${tTag} ${fTag}`) : val.replace(tTag, `${fTag} ${tTag}`);
            tw.value = val.replace('___TEMP_LM___', '').replace(/[ \t]{2,}/g, ' ').trim();
            if (tw.inputEl) tw.inputEl.value = tw.value;
            node.onWidgetChanged?.(tw.name, tw.value, tw.value, tw);
            if (typeof tw.callback === 'function') tw.callback(tw.value);
          }
        }

        // 2. 若是 LoRA 则同步调换内部数据顺序
        if (cardType === 'lora') {
          const lorasData = parseLoraValue(widget.value);
          const fromIdx = lorasData.findIndex(item => item.name === fromName);
          const toIdx = lorasData.findIndex(item => item.name === toName);
          if (fromIdx >= 0 && toIdx >= 0) {
            const [moved] = lorasData.splice(fromIdx, 1);
            lorasData.splice(toIdx, 0, moved);
            updateWidgetValue(formatLoraValue(lorasData));
          }
        }

        // 3. 刷新卡片列表
        renderLoras(widget.value, widget);
      });
    };    

    if (widget.__activeTab === 'lora' && lorasData.length === 0) {
      const emptyMessage = document.createElement("div");
      emptyMessage.textContent = "No LoRAs added";
      emptyMessage.className = "lm-lora-empty-state";
      container.appendChild(emptyMessage);
      updateNodeErrorFlag(false);
      return;
    }

    // Create header
    const header = document.createElement("div");
    header.className = "lm-loras-header";

    const stopDrag = (el) => {
      el.addEventListener("pointerdown", (e) => e.stopPropagation());
      el.addEventListener("mousedown", (e) => e.stopPropagation());
    };

    let isTextCollapsed = true;
    const applyTextWidgetVisibility = (collapse) => {
      isTextCollapsed = (collapse !== undefined) ? collapse : !isTextCollapsed;
      container.dataset.syntaxOpen = isTextCollapsed ? "false" : "true";
      const textWidget = node.widgets?.find(w => w.name === "text");
      if (!textWidget) return;
      const domEl = textWidget.element || textWidget.inputEl?.closest('.comfy-multiline-input') || textWidget.inputEl?.parentElement || textWidget.inputEl;
      if (domEl) domEl.style.display = isTextCollapsed ? "none" : "";
      if (!textWidget.__origComputeSize) textWidget.__origComputeSize = textWidget.computeSize || ((w) => [w, 60]);
      if (isTextCollapsed) {
        textWidget.computeSize = () => [0, -4];
        textWidget.hidden = true;
      } else {
        textWidget.computeSize = textWidget.__origComputeSize;
        textWidget.hidden = false;
      }
      if (window.app?.canvas) window.app.canvas.setDirty(true, true);
    };

    if (!node.__textWidgetInitialized) {
      node.__textWidgetInitialized = true;
      setTimeout(() => {
        applyTextWidgetVisibility(true);
        // 核心：监听语法文本框变动（小飞机新增语法、手动修改或删除语法），自动保存
        const textWidget = node.widgets?.find(w => w.name === "text");
        if (textWidget) {
          let lastText = textWidget.value;
          const origCb = textWidget.callback;
          textWidget.callback = function(...args) {
            // 核心：文本框语法内容真正发生变动（新卡片发送加入、删除文本）才保存
            if (textWidget.value !== lastText) {
              lastText = textWidget.value;
              triggerAutoSave();
            }
            return origCb?.apply(this, args);
          };
        }
      }, 50);
    }   

    // 语法按钮独立成型，挂载在顶层左侧
    const textToggleBtn = document.createElement("div");
    textToggleBtn.className = "lm-filter-btn lm-syntax-toggle-btn";
    textToggleBtn.textContent = "📄 语法";
    textToggleBtn.title = "点击展开 / 折叠原始语法文本框";
    textToggleBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      applyTextWidgetVisibility();
      textToggleBtn.classList.toggle("active", !isTextCollapsed);
    });
    stopDrag(textToggleBtn);
    tabsBar.appendChild(textToggleBtn);

    // ── 分类过滤标签：安全恢复并保留选中状态 ──
    const filterRow = document.createElement("div");
    filterRow.className = "lm-filter-tags-row";
    stopDrag(filterRow);

    const filterTags = ["全部", "Anima", "ERNIE", "Flux", "Flux2", "Ideogram4", "Krea2", "LTX2.3", "MiniMax-H3","Qwen-Image", "SDXL", "Z-Image"];
    
    // 🎯 核心：优先继承上次点击的标签，切 TAB 原地不动
    let currentTag = widget.__savedTag || "全部";

    const searchWrapper = document.createElement("div");
    searchWrapper.className = "lm-search-wrapper";
    stopDrag(searchWrapper);

    const searchIcon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    searchIcon.setAttribute("viewBox", "0 0 24 24");
    searchIcon.setAttribute("class", "lm-search-icon");
    searchIcon.innerHTML = `<path d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 14z"/>`;

    const searchInput = document.createElement("input");
    searchInput.type = "text";
    searchInput.placeholder = "搜索...";
    searchInput.className = "lm-search-input";

    searchWrapper.appendChild(searchIcon);
    searchWrapper.appendChild(searchInput);

    const applyFilter = () => {
      const keyword = searchInput.value.trim().toLowerCase();
      const targetTag = currentTag === "全部" ? "" : currentTag.toLowerCase();

      container.querySelectorAll('.lm-lora-entry').forEach(card => {
        const loraName = (card.dataset.loraName || "").toLowerCase();
        const matchKeyword = !keyword || loraName.includes(keyword);
        // 核心：只强等于比对物理文件夹，不搜模型文件名
        const cardFolder = (card.dataset.folder || "").toLowerCase();
        const matchTag = !targetTag || (cardFolder === targetTag) || cardFolder.startsWith(targetTag + '/');
        card.style.display = (matchKeyword && matchTag) ? "" : "none";
      });
    };

    searchInput.addEventListener("input", applyFilter);

    filterTags.forEach(tag => {
      const btn = document.createElement("div");
      // 🎯 哪个标签被记住了，哪个就保持 active
      btn.className = "lm-filter-btn" + (tag === currentTag ? " active" : "");
      btn.textContent = tag;
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        filterRow.querySelectorAll('.lm-filter-btn').forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        currentTag = tag;
        widget.__savedTag = tag; // 🎯 记住当前选中的标签
        applyFilter();
      });
      filterRow.appendChild(btn);
    });

    tabsTopRow.appendChild(textToggleBtn);
    tabsTopRow.appendChild(searchWrapper);
    tabsBar.appendChild(filterRow);

    // 🎯 重新上屏后执行一次过滤，确保内容和标签一致
    setTimeout(applyFilter, 0);
    
// ── 大模型 TAB 渲染分支 ──
    if (widget.__activeTab === 'ckpt') {
      const rawText = node.inputWidget?.value || "";
      // 从节点的原始语法栏中精确提取所有 <model:文件名:xxx> 标签并去重
      const modelMatches = [...rawText.matchAll(/<model:([^:>]+)(?::([^>]+))?>/gi)];
      const targetModelNames = [...new Set(modelMatches.map(m => m[1].trim()))];

      // 移除已有的大模型卡片，防止并发回调导致双份
      container.querySelectorAll('.lm-ckpt-card, .lm-lora-empty-state').forEach(el => el.remove());

      if (targetModelNames.length === 0) {
        const emptyMessage = document.createElement("div");
        emptyMessage.textContent = "未添加大模型，请从后台点击小飞机发送";
        emptyMessage.className = "lm-lora-empty-state";
        container.appendChild(emptyMessage);
        return;
      }

      // 标记当前请求渲染批次 ID，拦截过期的重复回调
      const renderBatchId = Date.now();
      widget.__lastCkptBatchId = renderBatchId;

      // 获取当前选中的大模型（默认选中第 1 个）
      if (!widget.__selectedCkptName && targetModelNames.length > 0) {
        widget.__selectedCkptName = targetModelNames[0];
      }

      fetch('/api/lm/checkpoints/list?page=1&page_size=2000')
        .then(res => res.json())
        .then(json => {
          // 如果不是最新的一次渲染批次，直接作废抛弃，绝不重复生成
          if (widget.__lastCkptBatchId !== renderBatchId) return;

          // 再次安全清理，确保挂载前只有一份
          container.querySelectorAll('.lm-ckpt-card, .lm-lora-empty-state').forEach(el => el.remove());

          const list = json.items || json.models || (Array.isArray(json) ? json : []);

          targetModelNames.forEach(rawName => {
            const cleanTarget = rawName.replace(/\\/g, '/').toLowerCase();
            const pureTarget = cleanTarget.split('/').pop().replace(/\.(safetensors|pt|ckpt|bin)$/i, '');

            // 在模型库中精确匹配出对应模型元数据
            const m = list.find(item => {
              const itemFile = (item.file_name || '').toLowerCase().replace(/\.(safetensors|pt|ckpt|bin)$/i, '');
              const itemPath = (item.file_path || '').replace(/\\/g, '/').toLowerCase();
              return itemFile === pureTarget || itemPath.endsWith(cleanTarget);
            }) || { file_name: rawName, model_name: rawName };

            const isSelected = (widget.__selectedCkptName === rawName);

            const card = document.createElement('div');
            card.className = 'lm-lora-entry lm-lora-card-mode lm-ckpt-card';
            card.dataset.selected = isSelected ? "true" : "false";
            // 核心：优先从后台读 folder，兜底从路径截取文件夹名
            card.dataset.folder = m.folder || (rawName.includes('/') || rawName.includes('\\') ? rawName.split(/[/\\]/)[0] : '');
            card.dataset.loraName = rawName;

            const thumbWrapper = document.createElement('div');
            thumbWrapper.className = 'lm-card-thumb-wrapper';
            const rawPreviewUrl = m.preview_url || '/loras_static/images/no-preview.png';
            // 照抄 LoRA 与 ModelCard.js：追加时间戳彻底击穿浏览器缓存，后台上传立即同步显示
            const previewUrl = `${rawPreviewUrl}${rawPreviewUrl.includes('?') ? '&' : '?'}t=${Date.now()}`;
            const isVideo = rawPreviewUrl.endsWith('.mp4') || rawPreviewUrl.endsWith('.webm');

            if (isVideo) {
              const video = document.createElement('video');
              video.className = 'lm-card-thumb-img';
              video.src = previewUrl;
              video.loop = true;
              video.muted = true;
              video.playsInline = true;
              // 默认静止不自动播放，鼠标悬停卡片时才动
              card.addEventListener("mouseenter", () => {
                video.play().catch(() => {});
              });
              card.addEventListener("mouseleave", () => {
                video.pause();
                video.currentTime = 0;
              });
              thumbWrapper.appendChild(video);
            } else {
              const img = document.createElement('img');
              img.className = 'lm-card-thumb-img';
              img.src = previewUrl;
              thumbWrapper.appendChild(img);
            }

            const topBar = document.createElement('div');
            topBar.className = 'lm-card-top-bar';
            const topLeftGroup = document.createElement('div');
            topLeftGroup.className = 'lm-card-top-left';

            const baseBadge = document.createElement('div');
            baseBadge.className = 'lm-card-base-badge';
            baseBadge.style.display = 'inline-flex';
            baseBadge.innerHTML = `<span class="lm-base">${(m.base_model || 'CKPT').toUpperCase()}</span>`;
            topLeftGroup.appendChild(baseBadge);

            // 🎯 补齐大模型更新小箭头：检测到新版本亮起，点击直达主页
            if (m.update_available) {
              const updateBadge = document.createElement('div');
              updateBadge.className = 'lm-card-update-badge';
              updateBadge.textContent = '↑';
              updateBadge.title = '发现新版本，点击直达 Civitai 主页';
              updateBadge.style.display = 'inline-flex';
              updateBadge.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const modelId = m.civitai?.modelId || m.civitai?.id;
                const url = modelId
                  ? `https://civitai.com/models/${modelId}`
                  : `https://civitai.com/models?query=${encodeURIComponent(pureTarget)}`;
                window.open(url, '_blank');
              });
              topLeftGroup.appendChild(updateBadge);
            }

            topBar.appendChild(topLeftGroup);
            
            // 大模型齿轮：保持原样，纯粹用于打开工作台
            const ckptGearBtn = document.createElement("div");
            ckptGearBtn.className = "lm-card-gear-btn";
            ckptGearBtn.innerHTML = "⚙";
            ckptGearBtn.title = "打开 LoRA 管理工作台";
            ckptGearBtn.addEventListener("click", (e) => {
              e.preventDefault();
              e.stopPropagation();
              openLmFloatingWindow();
            });
            topBar.appendChild(ckptGearBtn);            

            const bottomBar = document.createElement('div');
            bottomBar.className = 'lm-card-bottom-bar';
            const nameLabel = document.createElement('div');
            nameLabel.className = 'lm-lora-name';
            nameLabel.textContent = m.model_name || m.file_name;
            bottomBar.appendChild(nameLabel);

// 🎯 补齐大模型版本标签（优先 Civitai 元数据，兜底识别 FP8/BF16/v1.0 等）
            const ckptVerBadge = document.createElement('div');
            ckptVerBadge.className = 'lm-card-version-badge';
            const extractCkptVer = () => {
              if (m.civitai?.name) return m.civitai.name;
              const s = `${m.file_name || ''} ${rawName || ''}`;
              const parts = [];
              const stepMatch = s.match(/(\d+[-_]?steps?)/i);
              const precMatch = s.match(/(bf16|fp16|fp8|v\d+(?:\.\d+)?)/i);
              if (stepMatch) parts.push(stepMatch[1].replace(/_/g, '-'));
              if (precMatch) parts.push(precMatch[1].toUpperCase());
              return parts.join(' ');
            };
            const verText = extractCkptVer();
            if (verText) {
              ckptVerBadge.textContent = verText;
              ckptVerBadge.style.display = 'inline-block';
            }
            bottomBar.appendChild(ckptVerBadge);            

            card.appendChild(thumbWrapper);
            card.appendChild(topBar);
            card.appendChild(bottomBar);
            bindCardDragAndSwap(card, rawName, 'ckpt');

            // 右键菜单：与 LoRA 共用一套菜单
            card.addEventListener('contextmenu', (e) => {
              e.preventDefault();
              e.stopPropagation();
              createContextMenu(e.clientX, e.clientY, rawName, widget, previewTooltip, renderLoras);
            });

            // 点击卡片：切换选中视觉，并触发三剑客下发（大模型 + CLIP + VAE）
            card.addEventListener('click', (e) => {
              if (e.target.closest('.lm-card-gear-btn')) return;
              e.stopPropagation();
              container.querySelectorAll('.lm-ckpt-card').forEach(c => c.dataset.selected = "false");
              card.dataset.selected = "true";
              widget.__selectedCkptName = rawName;

              sendModelToWorkflow(m);
              sendClipToWorkflow(m, e);
              sendVaeToWorkflow(m, e);
              syncStepsOnCkptSelect(widget, m, rawName);
            });

            container.appendChild(card);
          });
          // 🎯 核心关键：等大模型卡片全部异步挂载到 DOM 之后，立即执行过滤！
          applyFilter();
        });
      return; // 阻止向下继续执行 LoRA 列表渲染
    }

    // Render each lora entry
    const availableSet = getAvailableLorasSync();
    if (!availableSet) {
      // Availability data missing (workflow switch without node recreation,
      // cache expiry): fetch it and re-render once it lands so missing cues
      // and the node flag always resolve. Only re-render on success to avoid
      // retry loops on failure.
      getAvailableLoras().then((set) => {
        if (set && !widget.__dragActive && container.isConnected) {
          renderLoras(widget.value, widget);
        }
      });
    }
    lorasData.forEach((loraData) => {
      const { name, strength, clipStrength, active } = loraData;
      const missing = !isLoraNameAvailable(name, availableSet);
      
      // Determine expansion state using our helper function
      const isExpanded = shouldShowClipEntry(loraData);
      const strengthFocusEntry = createFocusEntry(name, "strength");
      
      // Create the main LoRA entry
      const loraEl = document.createElement("div");
      loraEl.className = "lm-lora-entry";

      // Store lora name, active state, and locked state in dataset
      loraEl.dataset.loraName = name;
      // 核心：截取 LoRA 文件名前面的上级物理文件夹
      loraEl.dataset.folder = (name.includes('/') || name.includes('\\')) ? name.split(/[/\\]/)[0] : '';
      loraEl.dataset.active = active ? "true" : "false";

      if (missing) {
        loraEl.setAttribute("data-missing", "true");
      }

      // 切换 LoRA 启用/停用状态
      const toggleLoraState = () => {
        const lorasData = parseLoraValue(widget.value);
        const loraIndex = lorasData.findIndex(l => l.name === name);
        if (loraIndex >= 0) {
          const newActive = !lorasData[loraIndex].active;
          lorasData[loraIndex].active = newActive;
          loraEl.dataset.active = newActive ? "true" : "false";
          if (newActive) {
            syncStepsToSampler(name, loraEl);
          } else {
            syncStepsToSampler(null);
          }       
          if (selectedLora === name) {
            emitSelectionChange({
              name,
              active: newActive,
              entry: { ...lorasData[loraIndex] },
            });
          }
          widget.__skipRender = true;
          updateWidgetValue(formatLoraValue(lorasData));
          widget.__skipRender = false;
          updateLoraTabBadge();
        }
      };

      // 点击整张卡片：选中并切换状态（避开齿轮、小蓝箭头、输入框）
      loraEl.addEventListener('click', (e) => {
        if (e.target.closest('input') ||
            e.target.closest('.lm-lora-arrow') ||
            e.target.closest('.lm-lora-drag-handle') ||
            e.target.closest('.lm-lora-lock-button') ||
            e.target.closest('.lm-card-update-badge') ||
            e.target.closest('.lm-card-gear-btn') ||
            e.target.closest('.lm-lora-expand-button')) {
          return;
        }

        e.preventDefault();
        e.stopPropagation();

        selectLora(name);
        toggleLoraState();
      });

      // Conditionally create drag handle OR lock button
      let dragHandleOrLockButton = null;
      if (isRandomizerNode) {
        const isLocked = loraData.locked || false;
        dragHandleOrLockButton = createLockButton(isLocked, (newLocked) => {
          const lorasData = parseLoraValue(widget.value);
          const loraIndex = lorasData.findIndex(l => l.name === name);
          if (loraIndex >= 0) {
            lorasData[loraIndex].locked = newLocked;
            updateWidgetValue(formatLoraValue(lorasData));
          }
        });
      }

      // 整张卡片直接作为拖拽实体
      bindCardDragAndSwap(loraEl, name, 'lora');

      // Create toggle for this lora
      const toggle = createToggle(active, (newActive) => {
        loraEl.dataset.active = newActive ? "true" : "false";
        
        const lorasData = parseLoraValue(widget.value);
        const loraIndex = lorasData.findIndex(l => l.name === name);
        if (loraIndex >= 0) {
          lorasData[loraIndex].active = newActive;
          if (selectedLora === name) {
            emitSelectionChange({
              name,
              active: newActive,
              entry: { ...lorasData[loraIndex] },
            });
          }
          const newValue = formatLoraValue(lorasData);
          updateWidgetValue(newValue);
        }
      });

      // Create expand button
      const expandButton = createExpandButton(isExpanded, (shouldExpand) => {
        // Toggle the clip entry expanded state
        const lorasData = parseLoraValue(widget.value);
        const loraIndex = lorasData.findIndex(l => l.name === name);
        
        if (loraIndex >= 0) {
          // Set the expansion state
          lorasData[loraIndex].expanded = shouldExpand;
          
          // If collapsing, set clipStrength = strength
          if (!shouldExpand) {
            lorasData[loraIndex].clipStrength = lorasData[loraIndex].strength;
          } 
          
          // Update the widget value
          updateWidgetValue(formatLoraValue(lorasData));

          // Re-render to show/hide clip entry
          renderLoras(widget.value, widget);
        }
      });

      // Create name display
      const nameEl = document.createElement("div");
      nameEl.textContent = name;
      nameEl.className = "lm-lora-name";
      if (missing) {
        nameEl.title = "LoRA not found in local library";
      }

      // Move preview tooltip events to nameEl instead of loraEl
      let previewTimer = null; // Timer for delayed preview

      const clearPreviewTimer = () => {
        if (previewTimer) {
          clearTimeout(previewTimer);
          previewTimer = null;
        }
      };

      nameEl.addEventListener('mouseenter', (e) => {
        e.stopPropagation();
        // Missing LoRAs have no preview data — skip the placeholder tooltip.
        if (missing || shouldSuppressPreview()) {
          return;
        }
        previewTimer = setTimeout(async () => {
          previewTimer = null;
          if (shouldSuppressPreview()) {
            return;
          }
          const rect = nameEl.getBoundingClientRect();
          await previewTooltip.show(name, rect.right, rect.top);
        }, 400); // 400ms delay
      });

      nameEl.addEventListener('mouseleave', (e) => {
        e.stopPropagation();
        clearPreviewTimer(); // Cancel if not triggered
        previewTooltip.hide();
      });

      // Add context menu event
      loraEl.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        createContextMenu(e.clientX, e.clientY, name, widget, previewTooltip, renderLoras);
      });

      // Create strength control
      const strengthControl = document.createElement("div");
      strengthControl.className = "lm-lora-strength-control";

      // Left arrow
      const leftArrow = createArrowButton("left", () => {
        // Decrease strength
        const lorasData = parseLoraValue(widget.value);
        const loraIndex = lorasData.findIndex(l => l.name === name);
        
        if (loraIndex >= 0) {
          lorasData[loraIndex].strength = (parseFloat(lorasData[loraIndex].strength) - getStrengthStepPreference()).toFixed(2);
          // Sync clipStrength if collapsed
          syncClipStrengthIfCollapsed(lorasData[loraIndex]);
          
          const newValue = formatLoraValue(lorasData);
          updateWidgetValue(newValue);
        }
      });

      // Strength display
      const strengthEl = document.createElement("input");
      strengthEl.classList.add("lm-lora-strength-input");
      strengthEl.type = "text";
      strengthEl.value = typeof strength === 'number' ? strength.toFixed(2) : Number(strength).toFixed(2);
      strengthEl.addEventListener('pointerdown', () => {
        pendingFocusTarget = { name, type: "strength" };
      });

        // Handle focus
        strengthEl.addEventListener('focus', () => {
          pendingFocusTarget = null;
          // Auto-select all content
          strengthEl.select();
          selectLora(name);
        });

      // Handle input changes
      const commitStrengthValue = () => {
        let parsedValue = parseFloat(strengthEl.value);
        if (isNaN(parsedValue)) {
          parsedValue = 1.0;
        }
        const normalizedValue = parsedValue.toFixed(2);

        const currentLoras = parseLoraValue(widget.value);
        const loraIndex = currentLoras.findIndex(l => l.name === name);

        if (loraIndex >= 0) {
          currentLoras[loraIndex].strength = normalizedValue;
          // Sync clipStrength if collapsed
          syncClipStrengthIfCollapsed(currentLoras[loraIndex]);

          strengthEl.value = normalizedValue;
          const newLorasValue = formatLoraValue(currentLoras);
          updateWidgetValue(newLorasValue);
        } else {
          strengthEl.value = normalizedValue;
        }
      };

      strengthEl.addEventListener('change', commitStrengthValue);

      // Handle key events
      strengthEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          strengthEl.blur();
        } else if (e.key === 'Tab') {
          const moved = queueFocusAdjacentFrom(strengthFocusEntry, e.shiftKey ? -1 : 1);
          commitStrengthValue();
          if (moved) {
            e.preventDefault();
          }
        }
      });

      // Right arrow
      const rightArrow = createArrowButton("right", () => {
        // Increase strength
        const lorasData = parseLoraValue(widget.value);
        const loraIndex = lorasData.findIndex(l => l.name === name);
        
        if (loraIndex >= 0) {
          lorasData[loraIndex].strength = (parseFloat(lorasData[loraIndex].strength) + getStrengthStepPreference()).toFixed(2);
          // Sync clipStrength if collapsed
          syncClipStrengthIfCollapsed(lorasData[loraIndex]);
          
          const newValue = formatLoraValue(lorasData);
          updateWidgetValue(newValue);
        }
      });

      strengthControl.appendChild(leftArrow);
      strengthControl.appendChild(strengthEl);
      strengthControl.appendChild(rightArrow);

      // Assemble entry (宫格缩略图卡片化改造)
      // 1. 创建缩略图容器与默认占位图
      const thumbWrapper = document.createElement("div");
      thumbWrapper.className = "lm-card-thumb-wrapper";

      const thumbImg = document.createElement("img");
      thumbImg.className = "lm-card-thumb-img";
      thumbImg.loading = "lazy";
      thumbImg.style.backgroundColor = "#222";
      thumbWrapper.appendChild(thumbImg);

      // ── 2. 左上角底模药丸 (LoRA | QWEN) ──
      const baseModelBadge = document.createElement("div");
      baseModelBadge.className = "lm-card-base-badge";

      // ── 3. 左下角版本/步数精度小标签 (8-Step BF16) ──
      const versionBadge = document.createElement("div");
      versionBadge.className = "lm-card-version-badge";

      // ── 双重保险：从后台接口 / 本地文件名智能提取标签 ──
      const applyBadges = (base, version) => {
        if (base) {
          baseModelBadge.innerHTML = `<span class="lm-base">${base.toUpperCase()}</span>`;
          baseModelBadge.style.display = "inline-flex";
        }
        if (version) {
          versionBadge.textContent = version;
          versionBadge.style.display = "inline-block";
        }
      };

// 现代保底解析：抛弃死板猜名，直接提取上层文件夹作为底模，保留步数精度秒显
      const parseFallback = (str) => {
        // 1. 底模直接认上级文件夹名（如 QWEN-IMAGE、FLUX2）
        const b = (str.includes('/') || str.includes('\\')) ? str.split(/[/\\]/)[0].toUpperCase() : "";
        let v = "";

        // 2. 提取文件名里的 4step/8step/FP8 作为秒开徽章
        const stepMatch = str.match(/(\d+[-_]?steps?)/i);
        const precMatch = str.match(/(bf16|fp16|fp8|v\d+(?:\.\d+)?)/i);
        const parts = [];
        if (stepMatch) parts.push(stepMatch[1].replace(/_/g, '-'));
        if (precMatch) parts.push(precMatch[1].toUpperCase());
        if (parts.length > 0) v = parts.join(' ');

        return { b, v };
      };

      // 先用文件名兜底瞬间点亮（不让界面空白）
      const fallback = parseFallback(name);
      if (fallback.b || fallback.v) {
        applyBadges(fallback.b, fallback.v);
      }

      // 异步读取图片与友好别名
      previewTooltip.resolvePreviewData(name).then((data) => {
        if (!data) return;
        if (data.previewUrl) {
          if (data.previewUrl.endsWith(".mp4") || data.previewUrl.endsWith(".webm")) {
            const video = document.createElement("video");
            video.className = "lm-card-thumb-img";
            video.src = data.previewUrl;
            video.loop = true;
            video.muted = true;
            video.playsInline = true;
            // 默认静止不自动播放，鼠标悬停卡片时才动
            loraEl.addEventListener("mouseenter", () => {
              video.play().catch(() => {});
            });
            loraEl.addEventListener("mouseleave", () => {
              video.pause();
              video.currentTime = 0;
            });
            thumbWrapper.replaceChild(video, thumbImg);
          } else {
            thumbImg.src = `${data.previewUrl}${data.previewUrl.includes('?') ? '&' : '?'}t=${Date.now()}`;
          }
        }
        if (data.displayName && nameEl) {
          nameEl.textContent = data.displayName;
          nameEl.title = `${data.displayName} (${name})`;
        }
      }).catch(() => {
        thumbImg.style.opacity = "0.2";
      });

      // 异步从官方真实接口拉取精准 CivitAI 元数据覆盖
      (async () => {
        try {
          const res = await (window.comfyAPI?.api?.fetchApi || fetch)('/api/lm/loras/list?page=1&page_size=2000');
          if (!res.ok) return;
          const json = await res.json();
          const list = json.items || json.models || (Array.isArray(json) ? json : []);
          
          const cleanPath = name.replace(/\\/g, '/').toLowerCase();
          const pureName = cleanPath.split('/').pop().replace(/\.(safetensors|pt|ckpt)$/i, '');

          const match = list.find(m => {
            const mFile = (m.file_name || '').toLowerCase().replace(/\.(safetensors|pt|ckpt)$/i, '');
            const mPath = (m.file_path || '').replace(/\\/g, '/').toLowerCase();
            return mFile === pureName || mPath.endsWith(cleanPath);
          });

          if (match) {
            if (match.folder) {
              loraEl.dataset.folder = match.folder;
              applyFilter();
            }
            const base = match.base_model || fallback.b;
            const ver = match.civitai?.name || fallback.v;
            applyBadges(base, ver);

            const displayName = match.title || match.model_name || match.display_name || match.civitai?.model?.name;
            if (displayName && nameEl) {
              nameEl.textContent = displayName;
              nameEl.title = `${displayName} (${name})`;
            }

            // 1. 小蓝箭头：检测到有新版本直接亮起，点击新标签页直达 Civitai 模型主页
            if (match.update_available) {
              updateBadge.style.display = "inline-flex";
              updateBadge.addEventListener("click", (e) => {
                e.preventDefault();
                e.stopPropagation();
                const modelId = match.civitai?.modelId || match.civitai?.id;
                const url = modelId
                  ? `https://civitai.com/models/${modelId}`
                  : `https://civitai.com/models?query=${encodeURIComponent(pureName)}`;
                window.open(url, "_blank");
              });
            }

            // 2. 右上角齿轮：唤出独立浮窗（可移动/可拉伸放大缩小/72%贴合缩放/关闭彻底清空内存）
            gearBtn.addEventListener("click", async (e) => {
              e.preventDefault();
              e.stopPropagation();

              let win = document.getElementById("lm-floating-window");
              if (!win) {
                win = document.createElement("div");
                win.id = "lm-floating-window";

                // 标题栏（拖拽把手）
                let currentZoom = parseInt(localStorage.getItem("lm-floating-zoom") || "72", 10);

                // 标题栏（拖拽把手 + 缩放滑块）
                const header = document.createElement("div");
                header.id = "lm-floating-header";
                header.innerHTML = `
                  <div style="display:flex;align-items:center;">
                    <span id="lm-floating-title">✨ LoRA Manager</span>
                    <div class="lm-floating-zoom-wrap" title="拖动调节窗口内网页缩放比例">
                      <span>缩放:</span>
                      <input type="range" class="lm-floating-zoom-slider" id="lm-floating-zoom-input" min="40" max="120" value="${currentZoom}" step="1">
                      <span id="lm-floating-zoom-val">${currentZoom}%</span>
                    </div>
                  </div>
                  <div id="lm-floating-close">✕</div>
                `;

                // 内容包裹区与 iframe（缩放 72% 并贴合）
                const body = document.createElement("div");
                body.id = "lm-floating-body";

                const iframe = document.createElement("iframe");
                iframe.id = "lm-floating-iframe";
                iframe.setAttribute("sandbox", "allow-scripts allow-forms allow-same-origin allow-popups allow-presentation");
                iframe.setAttribute("loading", "lazy");

                body.appendChild(iframe);
                
// 动态贴合缩放函数（保证任何比例下都上下左右 100% 严密贴合）
                const applyIframeZoom = (percent) => {
                  const scale = percent / 100;
                  const ratio = (100 / scale).toFixed(6);
                  iframe.style.width = `${ratio}%`;
                  iframe.style.height = `${ratio}%`;
                  iframe.style.transform = `scale(${scale})`;
                  header.querySelector("#lm-floating-zoom-val").textContent = `${percent}%`;
                  localStorage.setItem("lm-floating-zoom", percent);
                };

                // 初始化应用保存的缩放比例
                applyIframeZoom(currentZoom);

                // 监听滑块拖动实时改变缩放
                const zoomInput = header.querySelector("#lm-floating-zoom-input");
                zoomInput.addEventListener("input", (ev) => {
                  applyIframeZoom(parseInt(ev.target.value, 10));
                });
                // 阻止滑块拖动时触发窗口移动
                zoomInput.addEventListener("mousedown", (ev) => ev.stopPropagation());                
                
                win.appendChild(header);
                win.appendChild(body);
                document.body.appendChild(win);

                // 拖拽窗口移动逻辑
                let isDragging = false, startX, startY, initLeft, initTop;
                header.addEventListener("mousedown", (ev) => {
                  if (ev.target.id === "lm-floating-close") return;
                  isDragging = true;
                  startX = ev.clientX;
                  startY = ev.clientY;
                  const rect = win.getBoundingClientRect();
                  initLeft = rect.left;
                  initTop = rect.top;
                  document.addEventListener("mousemove", onMouseMove);
                  document.addEventListener("mouseup", onMouseUp);
                });

                const onMouseMove = (ev) => {
                  if (!isDragging) return;
                  win.style.left = `${initLeft + (ev.clientX - startX)}px`;
                  win.style.top = `${initTop + (ev.clientY - startY)}px`;
                };

                const onMouseUp = () => {
                  isDragging = false;
                  document.removeEventListener("mousemove", onMouseMove);
                  document.removeEventListener("mouseup", onMouseUp);
                };

                // 关闭时彻底销毁释放显存和内存
                header.querySelector("#lm-floating-close").onclick = () => {
                  win.style.display = "none";
                  iframe.src = "about:blank"; // 瞬间释放显存与内存占用
                };
              }

              // 自动探测 URL（复用 lora_frame_v5 的探测逻辑）
              let targetUrl = `${window.location.origin}/loras`;
              try {
                const check = await fetch(targetUrl, { method: "HEAD", cache: "no-cache" });
                if (!check.ok) throw new Error();
              } catch {
                try {
                  const res = await fetch("/lora-web-frame/scan-port");
                  const d = await res.json();
                  if (d.url) targetUrl = d.url;
                } catch {
                  targetUrl = "http://127.0.0.1:8000/loras";
                }
              }

              // 载入 URL 并展示窗口（无黑遮罩，不遮挡工作流）
              const iframe = document.getElementById("lm-floating-iframe");
              if (iframe.src !== targetUrl) {
                iframe.src = targetUrl;
              }
              win.style.display = "flex";
            });
          }
        } catch (e) {}
      })();

// ── 4. 顶部栏 (左: 底模药丸 + 小蓝更新箭头；右: 齿轮按钮) ──
      const updateBadge = document.createElement("div");
      updateBadge.className = "lm-card-update-badge";
      updateBadge.textContent = "↑";
      updateBadge.title = "发现新版本，点击直达 Civitai 主页";

      const topLeftGroup = document.createElement("div");
      topLeftGroup.className = "lm-card-top-left";
      topLeftGroup.appendChild(baseModelBadge);
      topLeftGroup.appendChild(updateBadge);

      const gearBtn = document.createElement("div");
      gearBtn.className = "lm-card-gear-btn";
      gearBtn.innerHTML = "⚙";
      gearBtn.title = "打开 LoRA 管理工作台";

      const topBar = document.createElement("div");
      topBar.className = "lm-card-top-bar";
      topBar.appendChild(topLeftGroup);
      if (dragHandleOrLockButton) {
        topBar.appendChild(dragHandleOrLockButton);
      }
      topBar.appendChild(gearBtn);

      // ── 5. 底部信息栏 ──
      const bottomBar = document.createElement("div");
      bottomBar.className = "lm-card-bottom-bar";
      bottomBar.appendChild(nameEl);
      bottomBar.appendChild(versionBadge);
      bottomBar.appendChild(strengthControl);

      // ── 6. 装载进卡片 ──
      loraEl.classList.add("lm-lora-card-mode");
      loraEl.appendChild(thumbWrapper);
      loraEl.appendChild(topBar);
      loraEl.appendChild(bottomBar);

      container.appendChild(loraEl);

      // If expanded, show the clip entry
      if (isExpanded) {
        const clipEl = document.createElement("div");
        clipEl.className = "lm-lora-clip-entry";

        // Store the same lora name in clip entry dataset
        clipEl.dataset.loraName = name;
        clipEl.dataset.active = active ? "true" : "false";

        if (missing) {
          clipEl.setAttribute("data-missing", "true");
        }

        // Create clip name display
        const clipNameEl = document.createElement("div");
        clipNameEl.textContent = "[clip] " + name;
        clipNameEl.className = "lm-lora-name";
        if (missing) {
          clipNameEl.title = "LoRA not found in local library";
        }

        // Create clip strength control
        const clipStrengthControl = document.createElement("div");
        clipStrengthControl.className = "lm-lora-strength-control";

        // Left arrow for clip
        const clipLeftArrow = createArrowButton("left", () => {
          // Decrease clip strength
          const lorasData = parseLoraValue(widget.value);
          const loraIndex = lorasData.findIndex(l => l.name === name);
          
          if (loraIndex >= 0) {
            lorasData[loraIndex].clipStrength = (parseFloat(lorasData[loraIndex].clipStrength) - getStrengthStepPreference()).toFixed(2);
            
            const newValue = formatLoraValue(lorasData);
            updateWidgetValue(newValue);
          }
        });

        // Clip strength display
        const clipStrengthEl = document.createElement("input");
        clipStrengthEl.classList.add("lm-lora-strength-input", "lm-lora-clip-strength-input");
        clipStrengthEl.type = "text";
        clipStrengthEl.value = typeof clipStrength === 'number' ? clipStrength.toFixed(2) : Number(clipStrength).toFixed(2);
        clipStrengthEl.addEventListener('pointerdown', () => {
          pendingFocusTarget = { name, type: "clip" };
        });

        // Handle focus
        clipStrengthEl.addEventListener('focus', () => {
          pendingFocusTarget = null;
          // Auto-select all content
          clipStrengthEl.select();
          selectLora(name);
        });

        // Handle input changes
        const clipFocusEntry = createFocusEntry(name, "clip");

        const commitClipStrengthValue = () => {
          let parsedValue = parseFloat(clipStrengthEl.value);
          if (isNaN(parsedValue)) {
            parsedValue = 1.0;
          }
          const normalizedValue = parsedValue.toFixed(2);

          const currentLoras = parseLoraValue(widget.value);
          const loraIndex = currentLoras.findIndex(l => l.name === name);

          if (loraIndex >= 0) {
            currentLoras[loraIndex].clipStrength = normalizedValue;
            clipStrengthEl.value = normalizedValue;

            const newLorasValue = formatLoraValue(currentLoras);
            updateWidgetValue(newLorasValue);
          } else {
            clipStrengthEl.value = normalizedValue;
          }
        };

        clipStrengthEl.addEventListener('change', commitClipStrengthValue);

        // Handle key events
        clipStrengthEl.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            clipStrengthEl.blur();
          } else if (e.key === 'Tab') {
            const moved = queueFocusAdjacentFrom(clipFocusEntry, e.shiftKey ? -1 : 1);
            commitClipStrengthValue();
            if (moved) {
              e.preventDefault();
            }
          }
        });

        // Right arrow for clip
        const clipRightArrow = createArrowButton("right", () => {
          // Increase clip strength
          const lorasData = parseLoraValue(widget.value);
          const loraIndex = lorasData.findIndex(l => l.name === name);
          
          if (loraIndex >= 0) {
            lorasData[loraIndex].clipStrength = (parseFloat(lorasData[loraIndex].clipStrength) + getStrengthStepPreference()).toFixed(2);
            
            const newValue = formatLoraValue(lorasData);
            updateWidgetValue(newValue);
          }
        });

        clipStrengthControl.appendChild(clipLeftArrow);
        clipStrengthControl.appendChild(clipStrengthEl);
        clipStrengthControl.appendChild(clipRightArrow);

        // Assemble clip entry
        const clipLeftSection = document.createElement("div");
        clipLeftSection.className = "lm-lora-entry-left";

        clipLeftSection.appendChild(clipNameEl);

        clipEl.appendChild(clipLeftSection);
        clipEl.appendChild(clipStrengthControl);

        // Add drag functionality to clip entry
        initDrag(clipEl, name, widget, true, previewTooltip, renderLoras, {
          onDragStart: markStrengthDragStart,
          onDragEnd: markStrengthDragEnd
        });

        container.appendChild(clipEl);
      }
    });
    
    // After all LoRA elements are created, apply selection state as the last step
    // This ensures the selection state is not overwritten
    container.querySelectorAll('.lm-lora-entry').forEach(entry => {
      const entryLoraName = entry.dataset.loraName;
      updateEntrySelection(entry, entryLoraName === selectedLora);
    });

    // Flag the node when any active entry references a LoRA missing locally.
    // Skipped while the availability set is not loaded (null) to avoid
    // clearing or setting the flag based on incomplete information.
    const hasMissingActive = availableSet
      ? lorasData.some(
          (lora) => lora.active && !isLoraNameAvailable(lora.name, availableSet)
        )
      : null;
    updateNodeErrorFlag(hasMissingActive);

    const selectionExists = selectedLora
      ? currentLorasData.some((lora) => lora.name === selectedLora)
      : false;

    if (selectedLora && !selectionExists) {
      selectLora(null);
    } else if (selectedLora) {
      emitSelectionChange(buildSelectionPayload(selectedLora));
    }

    if (pendingFocusTarget) {
      const focusTarget = pendingFocusTarget;
      const safeName = escapeLoraName(focusTarget.name);
      let selector = "";

      if (focusTarget.type === "strength") {
        selector = `.lm-lora-entry[data-lora-name="${safeName}"] .lm-lora-strength-input`;
      } else if (focusTarget.type === "clip") {
        selector = `.lm-lora-clip-entry[data-lora-name="${safeName}"] .lm-lora-clip-strength-input`;
      }

      if (selector) {
        const targetInput = container.querySelector(selector);
        if (targetInput) {
          requestAnimationFrame(() => {
            targetInput.focus();
            if (typeof targetInput.select === "function") {
              targetInput.select();
            }
            selectLora(focusTarget.name, { silent: true });
          });
        }
      }

      pendingFocusTarget = null;
    }
  };

  // Store the value in a variable to avoid recursion
  let widgetValue = defaultValue;

  // Create widget with new DOM Widget API
  const widget = node.addDOMWidget(name, "custom", container, {
    canvasOnly: true,
    getValue: function() {
      return widgetValue.map(lora => {
        const entry = { ...lora };
        entry.selected = lora.name === selectedLora;
        return entry;
      });
    },
    setValue: function(v) {
      // Ensure v is an array; handle falsy, string, or object values safely
      v = Array.isArray(v) ? v : [];
      // Remove duplicates by keeping the last occurrence of each lora name
      const uniqueValue = v.reduce((acc, lora) => {
        // Remove any existing lora with the same name
        const filtered = acc.filter(l => l.name !== lora.name);
        // Add the current lora
        return [...filtered, lora];
      }, []);
      
      // Apply existing clip strength values and transfer them to the new value
      const updatedValue = uniqueValue.map(lora => {
        // For new loras, default clip strength to model strength and expanded to false
        // unless clipStrength is already different from strength
        const clipStrength = lora.clipStrength || lora.strength;
        return {
          ...lora,
          clipStrength: clipStrength,
          expanded: lora.hasOwnProperty('expanded') ?
                    lora.expanded :
                    Number(clipStrength) !== Number(lora.strength),
          locked: lora.hasOwnProperty('locked') ? lora.locked : false  // Initialize locked to false if not present
        };
      });

      widgetValue = updatedValue;

      // Restore selection state when loading a saved workflow
      if (!selectedLora) {
        const selectedEntry = updatedValue.find(lora => lora.selected);
        if (selectedEntry) {
          selectedLora = selectedEntry.name;
        }
      }

      if (!widget.__dragActive && !widget.__skipRender) {
        renderLoras(widgetValue, widget);
      }
    },
    hideOnZoom: true,
    selectOn: ['click', 'focus']
  });

  widget.value = defaultValue;
  
  widget.callback = callback;

  // Invalidate the availability cache and re-render when the local library
  // changes (e.g. a LoRA is deleted from the Lora Manager UI) so missing
  // cues and the node error flag update without waiting for the TTL.
  const unsubscribeLibraryChange = onLibraryChanged(() => {
    if (!widget.__dragActive && container.isConnected) {
      renderLoras(widget.value, widget);
    }
  });

  // Fetch the local library and re-render once available so missing entries
  // get their visual cue and the node error flag as soon as the data lands.
  getAvailableLoras().then(() => {
    if (!widget.__dragActive && container.isConnected) {
      renderLoras(widget.value, widget);
    }
  });

  widget.onRemove = () => {
    unsubscribeLibraryChange();
    if (errorFlagTimer !== null) {
      clearTimeout(errorFlagTimer);
      errorFlagTimer = null;
      pendingErrorFlag = null;
    }
    while (container.firstChild) {
      container.removeChild(container.firstChild);
    }
    previewTooltip.cleanup();
    container.removeEventListener('keydown', handleKeyboardNavigation);
  };

  return { minWidth: 400, minHeight: defaultHeight, widget };
}

// Node classes whose declared "loras" input (LORAS widget type) also applies
// trigger-word selection highlighting on lora selection.
const LORAS_WIDGET_HIGHLIGHT_NODE_CLASSES = new Set([
  "Lora Loader (LoraManager)",
  "Lora Stacker (LoraManager)",
  "Create Hook LoRA (LoraManager)",
]);

app.registerExtension({
  name: "LoraManager.LorasWidget",

  getCustomWidgets() {
    return {
      // Synchronous factory for the declared "loras" input (LORAS type) used by
      // Lora Loader / Lora Stacker / Create Hook LoRA / WanVideo Lora Select /
      // Lora Randomizer nodes. ComfyUI calls widget constructors synchronously,
      // so this must NOT be async.
      LORAS(node) {
        const comfyClass = node?.comfyClass;
        const isRandomizerNode = comfyClass === "Lora Randomizer (LoraManager)";

        const opts = { isRandomizerNode };

        if (isRandomizerNode || comfyClass === "WanVideo Lora Select (LoraManager)") {
          opts.onSelectionChange = (selection) => {
            updateConnectedLoraInfoNodes(node, selection);
          };
        } else if (LORAS_WIDGET_HIGHLIGHT_NODE_CLASSES.has(comfyClass)) {
          opts.onSelectionChange = (selection) => {
            applySelectionHighlight(node, selection);
            updateConnectedLoraInfoNodes(node, selection);
          };
        }

        // The randomizer has no per-node JS extension; update downstream
        // loaders directly from the widget callback. The other nodes assign
        // their own widget.callback in their onNodeCreated handlers.
        const callback = isRandomizerNode
          ? () => updateDownstreamLoaders(node)
          : null;

        return addLorasWidget(node, "loras", opts, callback);
      },
    };
  },
});

// ============================================================================
// 独立浮窗公用逻辑（放在最末尾全局生效，绝不影响顶部任何代码）
// ============================================================================
async function openLmFloatingWindow() {
  let win = document.getElementById("lm-floating-window");
  if (!win) {
    win = document.createElement("div");
    win.id = "lm-floating-window";

    let currentZoom = parseInt(localStorage.getItem("lm-floating-zoom") || "72", 10);

    const header = document.createElement("div");
    header.id = "lm-floating-header";
    header.innerHTML = `
      <div style="display:flex;align-items:center;">
        <span id="lm-floating-title">✨ LoRA Manager</span>
        <div class="lm-floating-zoom-wrap" title="拖动调节窗口内网页缩放比例">
          <span>缩放:</span>
          <input type="range" class="lm-floating-zoom-slider" id="lm-floating-zoom-input" min="40" max="120" value="${currentZoom}" step="1">
          <span id="lm-floating-zoom-val">${currentZoom}%</span>
        </div>
      </div>
      <div id="lm-floating-close">✕</div>
    `;

    const body = document.createElement("div");
    body.id = "lm-floating-body";

    const iframe = document.createElement("iframe");
    iframe.id = "lm-floating-iframe";
    iframe.setAttribute("sandbox", "allow-scripts allow-forms allow-same-origin allow-popups allow-presentation");
    iframe.setAttribute("loading", "lazy");
    body.appendChild(iframe);

    const applyIframeZoom = (percent) => {
      const scale = percent / 100;
      const ratio = (100 / scale).toFixed(6);
      iframe.style.width = `${ratio}%`;
      iframe.style.height = `${ratio}%`;
      iframe.style.transform = `scale(${scale})`;
      header.querySelector("#lm-floating-zoom-val").textContent = `${percent}%`;
      localStorage.setItem("lm-floating-zoom", percent);
    };
    applyIframeZoom(currentZoom);

    const zoomInput = header.querySelector("#lm-floating-zoom-input");
    zoomInput.addEventListener("input", (ev) => applyIframeZoom(parseInt(ev.target.value, 10)));
    zoomInput.addEventListener("mousedown", (ev) => ev.stopPropagation());

    win.appendChild(header);
    win.appendChild(body);
    document.body.appendChild(win);

    let isDragging = false, startX, startY, initLeft, initTop;
    header.addEventListener("mousedown", (ev) => {
      if (ev.target.id === "lm-floating-close") return;
      isDragging = true;
      startX = ev.clientX;
      startY = ev.clientY;
      const rect = win.getBoundingClientRect();
      initLeft = rect.left;
      initTop = rect.top;
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    });

    const onMouseMove = (ev) => {
      if (!isDragging) return;
      win.style.left = `${initLeft + (ev.clientX - startX)}px`;
      win.style.top = `${initTop + (ev.clientY - startY)}px`;
    };

    const onMouseUp = () => {
      isDragging = false;
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };

    header.querySelector("#lm-floating-close").onclick = () => {
      win.style.display = "none";
      iframe.src = "about:blank";
    };
  }

  let targetUrl = `${window.location.origin}/loras`;
  try {
    const check = await fetch(targetUrl, { method: "HEAD", cache: "no-cache" });
    if (!check.ok) throw new Error();
  } catch {
    try {
      const res = await fetch("/lora-web-frame/scan-port");
      const d = await res.json();
      if (d.url) targetUrl = d.url;
    } catch {
      targetUrl = "http://127.0.0.1:8000/loras";
    }
  }

  const iframe = document.getElementById("lm-floating-iframe");
  if (iframe.src !== targetUrl) iframe.src = targetUrl;
  win.style.display = "flex";
}