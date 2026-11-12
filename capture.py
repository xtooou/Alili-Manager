# -*- coding: utf-8 -*-
"""从「某次运行的节点参数（ComfyUI API 格式）」里读出：提示词 / 反向提示词 / 采样参数 / 底模 / LoRA。

设计原则：
- 不挂钩 ComfyUI，只读历史记录里保存的节点参数（或前端传来的当前画布）。
- 不针对任何一个节点写死类名：按「输入名 + 连线类型」通用地找，别的插件的节点同样适用。
- 读不到的项留空（由使用者手动编辑），绝不乱填。
"""
import json
import re

# 提示词常用的输入名（越靠前越优先）
TEXT_POS = ("prompt", "text", "positive", "positive_prompt", "text_positive", "caption", "string", "value",
            "populated_text", "wildcard_text", "text_g")
TEXT_NEG = ("negative_prompt", "negative", "negative_text", "text_negative")
# 沿连线找提示词时，这些类型 / 名字的连线不可能通向提示词，直接跳过
SKIP_TYPES = {"MODEL", "CLIP", "VAE", "LATENT", "IMAGE", "MASK", "CONTROL_NET", "CLIP_VISION", "CLIP_VISION_OUTPUT",
              "STYLE_MODEL", "UPSCALE_MODEL", "SAMPLER", "SIGMAS", "NOISE", "GUIDER", "GLIGEN"}
SKIP_NAMES = re.compile(r"^(vae|clip|model|latent.*|image.*|mask.*|trigger.*|lora.*|control_net|clip_vision.*|samples|"
                        r"pixels|sigmas|noise|sampler|guider|upscale_model)$", re.I)
# 纯 <lora:xx:1> / <model:xx:1> 语法的文本不是提示词（LoRA 加载器的文本框）
SYNTAX_ONLY = re.compile(r"<(?:lora|lyco|model)[^>]*>|[\s,，、]")
# 底模文件名常用的输入名
MODEL_KEYS = ("ckpt_name", "unet_name", "diffusion_model", "model_name", "checkpoint", "gguf_name", "base_model_name")
# 沿「模型」方向往上找加载节点时，允许走的连线
MODEL_LINK_TYPES = {"MODEL", "CLIP", "LORA_STACK"}
MODEL_LINK_NAMES = {"model", "clip", "base_model", "lora_stack", "model1", "model2"}


def _is_link(v):
    return isinstance(v, list) and len(v) == 2 and isinstance(v[1], int) and not isinstance(v[0], (dict, list))


def _idnum(nid):
    try:
        return int(nid)
    except (TypeError, ValueError):
        return 0


def _num(v, default=None):
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


class Graph:
    def __init__(self, prompt, defs=None):
        self.g = {str(k): v for k, v in (prompt or {}).items() if isinstance(v, dict)}
        self.defs = defs

    def node(self, nid):
        return self.g.get(str(nid))

    def inputs(self, nid):
        return (self.node(nid) or {}).get("inputs") or {}

    def itype(self, nid, name):
        """这个输入口声明的类型（取不到返回 None）"""
        try:
            ct = (self.node(nid) or {}).get("class_type")
            return self.defs(ct).get(name) if self.defs and ct else None
        except Exception:
            return None


# ───────────── 采样器 + 参数 ─────────────
def find_sampler(G):
    """有 positive / negative 输入的节点就是采样器；有多个（高清修复等）时取最后一级（不再喂给别的采样器的那个）"""
    cands = [nid for nid, n in G.g.items()
             if _is_link((n.get("inputs") or {}).get("positive")) and "negative" in (n.get("inputs") or {})]
    if not cands:
        return None
    feeds = {str(v[0]) for nid in cands for v in G.inputs(nid).values() if _is_link(v) and str(v[0]) in cands and str(v[0]) != nid}
    final = [c for c in cands if c not in feeds] or cands
    return sorted(final, key=_idnum)[-1]


def _scalar(G, v, depth=0):
    """输入可能是直接的值，也可能连到别的节点（种子节点 / 数值节点）：连线的话取源节点里第一个数值"""
    if not _is_link(v):
        return v
    if depth > 2:
        return None
    src = G.inputs(v[0])
    for k in ("value", "int", "float", "number", "seed", "noise_seed", "steps", "cfg", "string", "text"):
        x = src.get(k)
        if _is_link(x):
            x = _scalar(G, x, depth + 1)
        if isinstance(x, (int, float, str)) and not isinstance(x, bool):
            return x
    return None


def read_params(G, sid):
    inp = G.inputs(sid)
    pick = lambda *ks: next((_scalar(G, inp[k]) for k in ks if k in inp and _scalar(G, inp[k]) is not None), None)
    p = {"seed": pick("seed", "noise_seed"), "steps": pick("steps"), "cfg": pick("cfg"),
         "sampler": pick("sampler_name"), "scheduler": pick("scheduler"), "denoise": pick("denoise")}
    return {k: v for k, v in p.items() if v is not None}


# ───────────── 提示词 ─────────────
def _clean(s):
    s = (s or "").strip()
    return s if s and SYNTAX_ONLY.sub("", s) else ""


def _link_allowed(G, nid, name):
    t = G.itype(nid, name)
    return not ((t in SKIP_TYPES) or SKIP_NAMES.match(name))


def _text_from(G, nid, role, seen=frozenset(), depth=0):
    """从 nid 这个节点往上找「提示词文字」。role = positive | negative"""
    nid = str(nid)
    n = G.node(nid)
    if not n or nid in seen or depth > 8:
        return ""
    seen = seen | {nid}
    ct, inp = n.get("class_type", ""), n.get("inputs") or {}
    neg = role == "negative"
    if neg and re.search(r"zero", ct, re.I):  # ConditioningZeroOut：反向条件是清零的，没有文字
        return ""

    def val(v):
        if isinstance(v, str):
            return _clean(v)
        return _text_from(G, v[0], role, seen, depth + 1) if _is_link(v) else ""

    # 1) xxx_override：外部覆盖输入，优先级最高
    for k, v in inp.items():
        if re.fullmatch(r"negative\w*_override" if neg else r"(?:prompt|text|positive\w*)_override", k, re.I):
            t = val(v)
            if t:
                return t
    # 2) 前端状态 JSON（字符串里装着 {"prompt": ...}）
    keys = TEXT_NEG[:2] if neg else TEXT_POS[:3]
    for v in inp.values():
        if isinstance(v, str) and v.lstrip().startswith("{"):
            try:
                d = json.loads(v)
            except ValueError:
                continue
            if isinstance(d, dict):
                for k in keys:
                    t = _clean(d.get(k)) if isinstance(d.get(k), str) else ""
                    if t:
                        return t
    # 3) 按名字找。反向：节点里有「negative」字样的输入时只认它们，避免把正向提示词当成反向
    has_neg = any(re.search(r"negative", k, re.I) for k in inp)
    names = TEXT_NEG if (neg and has_neg) else ((("text",) + TEXT_POS) if neg else TEXT_POS)
    for k in names:
        if k in inp:
            t = val(inp[k])
            if t:
                return t
    if neg and has_neg:
        return ""
    # 4) 沿连线继续往上（条件、自定义类型都走；模型 / 图像 / 触发词之类不走）
    pref = re.compile(r"negative" if neg else r"cond|posit", re.I)
    links = [k for k, v in inp.items() if _is_link(v) and _link_allowed(G, nid, k)]
    for k in sorted(links, key=lambda k: 0 if pref.search(k) else 1):
        t = _text_from(G, inp[k][0], role, seen, depth + 1)
        if t:
            return t
    return ""


# ───────────── 底模 / LoRA ─────────────
def _model_walk(G, start):
    """从采样器的 model 输入往上走，返回路上经过的节点 id（按遇到的顺序）"""
    order, seen, queue = [], set(), [str(start[0])] if _is_link(start) else []
    while queue:
        nid = queue.pop(0)
        if nid in seen or not G.node(nid):
            continue
        seen.add(nid)
        order.append(nid)
        for k, v in G.inputs(nid).items():
            if not _is_link(v):
                continue
            t = G.itype(nid, k)
            if (t in MODEL_LINK_TYPES) if t else (k in MODEL_LINK_NAMES):
                queue.append(str(v[0]))
    return order


def _loras_in(inp):
    """一个节点里所有写法的 LoRA → [(名字, 权重)]"""
    out = []
    # 标准 / 常见：lora_name + strength*
    for k, v in inp.items():
        m = re.fullmatch(r"lora_(?:name_?)?(\d*)", k, re.I)
        if m and isinstance(v, str) and v.strip() and v.strip().lower() != "none":
            sfx = m.group(1)
            sk = [f"strength_model{'_' + sfx if sfx else ''}", f"strength{'_' + sfx if sfx else ''}",
                  f"lora_wt{'_' + sfx if sfx else ''}", f"lora_strength{'_' + sfx if sfx else ''}"]
            out.append((v.strip(), next((_num(inp[s], 1.0) for s in sk if s in inp and not _is_link(inp[s])), 1.0)))
        # rgthree Power Lora Loader：{"on": true, "lora": "x", "strength": 1}
        if isinstance(v, dict) and v.get("lora") and v.get("on", True):
            out.append((str(v["lora"]), _num(v.get("strength"), 1.0)))
        # LoRA Manager：[{"name":..,"strength":..,"active":..}]，只取开着的
        if isinstance(v, list) and v and all(isinstance(x, dict) for x in v):
            for x in v:
                if x.get("name") and x.get("active", True):
                    out.append((str(x["name"]), _num(x.get("strength"), 1.0)))
        # 状态 JSON：{"loras":[{"name":..,"w":..}]}（Alili 模型管理器）
        if isinstance(v, str) and v.lstrip().startswith("{"):
            try:
                d = json.loads(v)
            except ValueError:
                d = None
            if isinstance(d, dict):
                for x in d.get("loras") or []:
                    if isinstance(x, dict) and x.get("name"):
                        out.append((str(x["name"]), _num(x.get("w", x.get("strength")), 1.0)))
    return out


def _models_in(inp):
    out = [str(inp[k]).strip() for k in MODEL_KEYS if isinstance(inp.get(k), str) and inp[k].strip()][:1]
    for v in inp.values():  # Alili 模型管理器的状态 JSON
        if isinstance(v, str) and v.lstrip().startswith("{"):
            try:
                d = json.loads(v)
            except ValueError:
                continue
            if isinstance(d, dict):
                out += [str(x["name"]) for x in d.get("models") or [] if isinstance(x, dict) and x.get("name")]
    return out


def read_models(G, sid):
    models, loras, seen = [], [], set()
    for nid in reversed(_model_walk(G, G.inputs(sid).get("model"))):  # 从底模往采样器方向，即加载顺序
        inp = G.inputs(nid)
        for m in _models_in(inp):
            if m not in models:
                models.append(m)
        for name, w in _loras_in(inp):
            key = (name.lower(), w)
            if key not in seen:
                seen.add(key)
                loras.append({"name": name, "strength": w})
    return models, loras


# ───────────── 入口 ─────────────
def analyze(prompt, defs=None):
    """prompt = ComfyUI API 格式的节点字典；defs(class_type) → {输入名: 类型}（可选，让连线判断更准）"""
    out = {"prompt": "", "negative": "", "params": {}, "models": [], "loras": []}
    G = Graph(prompt, defs)
    sid = find_sampler(G)
    if sid is None:
        return out
    inp = G.inputs(sid)
    out["params"] = read_params(G, sid)
    out["prompt"] = _text_from(G, inp["positive"][0], "positive") if _is_link(inp.get("positive")) else ""
    out["negative"] = _text_from(G, inp["negative"][0], "negative") if _is_link(inp.get("negative")) else ""
    out["models"], out["loras"] = read_models(G, sid)
    return out
