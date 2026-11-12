"""后台接口。id 格式：<文件夹键>|<相对路径>，例如 loras|Flux2/Flux_2-Turbo-LoRA_comfyui.safetensors"""
import asyncio
import subprocess
import sys
import io
import json
import os
import re
import shutil
import time
import uuid
from datetime import datetime, timezone

from aiohttp import web
import folder_paths
from server import PromptServer

ROOT = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(ROOT, "web")
DATA = os.path.join(ROOT, "data")
os.makedirs(DATA, exist_ok=True)

EXTS = (".safetensors", ".ckpt", ".pt", ".pth", ".bin", ".gguf")
# 能当封面显示的图片后缀（含参考插件 ComfyUI-Lora-Manager 的 .preview.xxx 命名）
COVER_EXTS = (".jpeg", ".jpg", ".png", ".webp", ".preview.jpeg", ".preview.jpg", ".preview.png", ".preview.webp", ".gif", ".avif")
# 与模型同名的“配套文件”：改名 / 删除时必须一起处理（视频预览、元数据备份也算）
SIDE_EXTS = COVER_EXTS + (".preview.mp4", ".mp4", ".webm", ".jxl", ".metadata.json", ".metadata.json.bak")
KINDS = {"lora": ["loras"], "model": ["diffusion_models", "checkpoints", "unet"]}
BAD_NAME = re.compile(r'[<>:"/\\|?*\x00-\x1f]')

try:
    from . import capture  # 运行参数解析（提示词 / 采样参数 / 模型 / LoRA）
except ImportError:  # 单独加载（测试）时
    import capture

routes = PromptServer.instance.routes
IMAGES = os.path.join(ROOT, "images")  # 图标放这里：Alili-Manager/images/svg/*.svg
os.makedirs(os.path.join(IMAGES, "svg"), exist_ok=True)
routes.static("/alili/web", WEB, follow_symlinks=True)
routes.static("/alili/images", IMAGES, follow_symlinks=True)
print(f"[Alili-Manager] 图标目录：{os.path.join(IMAGES, 'svg')}")


# ───────────── 基础工具 ─────────────
def jerr(msg, status=400):
    return web.json_response({"error": msg}, status=status)


def load_json(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def save_json(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)  # 原子写入，避免写一半崩溃损坏


def norm(s):
    return re.sub(r"[^a-z0-9]", "", str(s).lower())


def clip_map():
    return load_json(os.path.join(ROOT, "clip_map.json"), {})


def settings():
    d = {"civitai_base": "https://civitai.red", "proxy": "", "api_key": "", "hide_early_access": False}  # 默认地址与参考插件一致（civitai.red）
    d.update(load_json(os.path.join(DATA, "settings.json"), {}))
    return d


def sidecar(full):
    return os.path.splitext(full)[0] + ".metadata.json"


def side_files(full):
    """与模型同名的全部配套文件 [(路径, 后缀)]（不含模型本身）：元数据、元数据备份、各种命名/格式的预览图或视频"""
    stem = os.path.splitext(full)[0]
    return [(stem + e, e) for e in SIDE_EXTS if os.path.exists(stem + e)]


def _int(v):
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def _ea_active(v):
    """版本是否仍在「早期访问」期内"""
    ends = v.get("earlyAccessEndsAt")
    if ends:
        try:
            return datetime.fromisoformat(str(ends).replace("Z", "+00:00")) > datetime.now(timezone.utc)
        except ValueError:
            return True
    return v.get("availability") == "EarlyAccess"


def norm_versions(mdl):
    """把 CivitAI /models/{id} 的版本列表精简成要存进 metadata 的样子"""
    out = []
    for v in (mdl or {}).get("modelVersions") or []:
        vid = _int(v.get("id")) if isinstance(v, dict) else None
        if vid is None:
            continue
        files = [f for f in (v.get("files") or []) if isinstance(f, dict)]
        main = next((f for f in files if f.get("primary")), None) or next((f for f in files if f.get("type") == "Model"), None) or (files[0] if files else None)
        try:
            size = int(float(main.get("sizeKB") or 0) * 1024) if main else 0
        except (TypeError, ValueError):
            size = 0
        out.append({"id": vid, "name": v.get("name") or "", "base": v.get("baseModel") or "",
                    "ea": _ea_active(v), "usage": v.get("usageControl") or "Download",
                    "published": v.get("publishedAt") or v.get("createdAt") or "", "size": size})
    return out


def creator_of(mdl):
    """作者用户名（用来拼作者主页）"""
    c = (mdl or {}).get("creator")
    return (c.get("username") or "") if isinstance(c, dict) else ""


def update_state(meta, lib, hide_ea=False):
    """按「参考插件」的规则判断有没有新版本（实时计算，不依赖存盘时的结论）：
    只看 版本号比本地大 + 基础模型相同 + 允许下载 的版本；本地已经有的版本不算；可选忽略早期访问。
    返回 {checked, update, latest}：latest = 可更新的最新版本；没有更新时是本地当前版本"""
    civ, al = meta.get("civitai") or {}, meta.get("alili") or {}
    mid, vid = _int(civ.get("modelId")), _int(civ.get("id"))
    if not mid or vid is None:
        return {"checked": False, "update": False, "latest": None}
    vers = al.get("versions")
    if vers is None:  # 旧版本只存了 latest
        old = al.get("latest") or {}
        oid = _int(old.get("id"))
        if oid is None:
            return {"checked": False, "update": False, "latest": None}
        return {"checked": True, "update": oid > vid, "latest": old if oid > vid else {"id": vid, "name": civ.get("name", "")}}
    base = norm(civ.get("baseModel") or meta.get("base_model") or "")
    have = (lib or {}).get(mid, set()) | {vid}
    ign = {_int(x) for x in al.get("ignored") or []}   # 用户点了「忽略此更新」的版本
    cands = [v for v in vers
             if v["id"] > vid and v["id"] not in have and v["id"] not in ign
             and (not base or not v.get("base") or norm(v["base"]) == base)
             and v.get("usage", "Download") == "Download"
             and not (hide_ea and v.get("ea"))]
    if cands:
        top = max(cands, key=lambda v: v["id"])
        return {"checked": True, "update": True, "latest": {"id": top["id"], "name": top["name"]}}
    return {"checked": True, "update": False, "latest": {"id": vid, "name": civ.get("name", "")}}


def version_rows(meta, lib, hide_ea=False):
    """给「模型列表页」用：这个 CivitAI 模型的全部版本（新的在前），带 已打开 / 已在库中 / 较新 / 已忽略 标记"""
    civ, al = meta.get("civitai") or {}, meta.get("alili") or {}
    mid, vid = _int(civ.get("modelId")), _int(civ.get("id"))
    if not mid or vid is None:
        return []
    base = norm(civ.get("baseModel") or meta.get("base_model") or "")
    have = (lib or {}).get(mid, set()) | {vid}
    ign = {_int(x) for x in al.get("ignored") or []}
    rows = []
    for v in sorted(al.get("versions") or [], key=lambda x: -x["id"]):
        ok = ((not base or not v.get("base") or norm(v["base"]) == base)
              and v.get("usage", "Download") == "Download" and not (hide_ea and v.get("ea")))
        rows.append({"id": v["id"], "name": v.get("name", ""), "base": v.get("base", ""), "size": v.get("size", 0),
                     "published": v.get("published", ""), "ea": bool(v.get("ea")),
                     "current": v["id"] == vid, "local": v["id"] in have,
                     "newer": v["id"] > vid and ok and v["id"] not in have, "ignored": v["id"] in ign})
    return rows


def find_cover(full):
    stem = os.path.splitext(full)[0]
    return next((stem + e for e in COVER_EXTS if os.path.exists(stem + e)), None)


def read_meta(full):
    return load_json(sidecar(full), {})


def write_meta(full, meta):
    if not meta.get("file_name"):
        meta.setdefault("file_name", os.path.splitext(os.path.basename(full))[0])
        meta.setdefault("file_path", full.replace("\\", "/"))
        meta.setdefault("size", os.path.getsize(full))
    save_json(sidecar(full), meta)


def roots_of(key):
    try:
        return folder_paths.get_folder_paths(key)
    except Exception:
        return []


def resolve(item_id):
    """id → (key, rel, 绝对路径)，并防止路径穿越"""
    key, _, rel = str(item_id).partition("|")
    if ".." in rel.replace("\\", "/").split("/"):
        raise ValueError("非法路径")
    for root in roots_of(key):
        full = os.path.normpath(os.path.join(root, rel))
        if os.path.commonpath([os.path.realpath(root), os.path.realpath(full)]) == os.path.realpath(root) and os.path.isfile(full):
            return key, rel.replace("\\", "/"), full
    raise FileNotFoundError("模型文件不存在")


def base_table():
    return load_json(os.path.join(ROOT, "base_models.json"), [])


def family(meta, rel):
    """返回 (家族键, 角标文字)。先查「基础模型维护表」，查不到再按名字模糊匹配 clip_map"""
    n = norm(meta.get("base_model", ""))
    ent = next((e for e in base_table() if norm(e["name"]) == n), None) if n else None
    if ent:
        return ent.get("family") or "", ent.get("badge") or ent["name"]
    cmap = sorted(clip_map(), key=len, reverse=True)  # 长的先判断（Flux2 先于 Flux）
    for text in (meta.get("base_model", ""), os.path.dirname(rel), os.path.basename(rel)):
        t = norm(text)
        hit = next((k for k in cmap if t and norm(k) in t), None)
        if hit:
            return hit, hit.upper()
    bm = meta.get("base_model") or "其他"
    return "", bm


_LIB = {}  # modelId -> 本地已有的版本号集合（最近一次扫描的结果，单条刷新时复用）


def to_item(kind, key, rel, full, meta=None, ctx=None):
    meta = read_meta(full) if meta is None else meta
    ctx = ctx or {"lib": _LIB, "hide_ea": bool(settings().get("hide_early_access"))}
    upd = update_state(meta, ctx["lib"], ctx["hide_ea"])
    civ = meta.get("civitai") or {}
    cover = find_cover(full)
    stem = os.path.splitext(os.path.basename(full))[0]
    fam, badge = family(meta, rel)
    return {
        "id": f"{key}|{rel}", "kind": kind, "key": key, "name": rel, "folder": os.path.dirname(rel).replace("\\", "/"),
        "file_name": stem, "title": meta.get("model_name") or stem, "version": civ.get("name", ""),
        "base_model": meta.get("base_model", ""), "family": fam, "badge": badge, "size": os.path.getsize(full),
        "triggers": civ.get("trainedWords") or [], "notes": meta.get("notes", ""), "tags": meta.get("tags", []),
        "favorite": bool(meta.get("favorite")), "exclude": bool(meta.get("exclude")),
        "cover": bool(cover), "cover_v": int(os.path.getmtime(cover)) if cover else 0,
        "model_id": civ.get("modelId"), "version_id": civ.get("id"),
        "latest": upd["latest"], "update": upd["update"], "update_checked": upd["checked"],
        "versions": version_rows(meta, ctx["lib"], ctx["hide_ea"]), "author": (meta.get("alili") or {}).get("creator", ""),
        "civ_base": settings()["civitai_base"].rstrip("/"),
        "checked_at": (meta.get("alili") or {}).get("checked_at", 0), "mtime": int(os.path.getmtime(full)),
    }


def scan(kind):
    seen, found = set(), []
    for key in KINDS[kind]:
        for root in roots_of(key):
            for dp, _, files in os.walk(root, followlinks=True):
                for f in files:
                    if not f.lower().endswith(EXTS):
                        continue
                    full = os.path.join(dp, f)
                    real = os.path.realpath(full)
                    if real in seen:  # diffusion_models 与 unet 可能是同一目录
                        continue
                    seen.add(real)
                    found.append((key, os.path.relpath(full, root).replace("\\", "/"), full, read_meta(full)))
    lib = {}  # 先看一遍本地都有哪些版本，再判断「有没有更新」（本地已经下过新版就不再提示）
    for _, _, _, meta in found:
        civ = meta.get("civitai") or {}
        if _int(civ.get("modelId")) and _int(civ.get("id")) is not None:
            lib.setdefault(_int(civ["modelId"]), set()).add(_int(civ["id"]))
    _LIB.update(lib)
    ctx = {"lib": lib, "hide_ea": bool(settings().get("hide_early_access"))}
    return [to_item(kind, key, rel, full, meta, ctx) for key, rel, full, meta in found]


def item_of(key, rel, full):
    meta = read_meta(full)
    civ = meta.get("civitai") or {}
    if _int(civ.get("modelId")) and _int(civ.get("id")) is not None:
        _LIB.setdefault(_int(civ["modelId"]), set()).add(_int(civ["id"]))
    return to_item("lora" if key == "loras" else "model", key, rel, full, meta)


def save_cover(full, image, src="custom"):
    from PIL import Image
    im = image.convert("RGB")
    im.thumbnail((1280, 1280), Image.LANCZOS)
    for e in COVER_EXTS:
        old = os.path.splitext(full)[0] + e
        if os.path.exists(old):
            os.remove(old)
    dst = os.path.splitext(full)[0] + ".jpeg"
    im.save(dst, "JPEG", quality=90)
    meta = read_meta(full)
    meta["preview_url"] = dst.replace("\\", "/")
    meta.setdefault("alili", {})["cover_src"] = src  # custom = 用户自己设的封面，同步 CivitAI 前会提示
    write_meta(full, meta)


def output_image(d):
    from PIL import Image
    base = folder_paths.get_directory_by_type(d.get("type") or "output")
    path = os.path.realpath(os.path.join(base, d.get("subfolder", ""), d["filename"]))
    if os.path.commonpath([os.path.realpath(base), path]) != os.path.realpath(base):
        raise ValueError("非法路径")
    return Image.open(path)


def broadcast(event, data):
    PromptServer.instance.send_sync(event, data)


# ───────────── 页面 ─────────────
@routes.get("/Manager")
async def page(_):
    with open(os.path.join(WEB, "manager.html"), encoding="utf-8") as f:
        html = f.read().replace("<head>", '<head>\n  <base href="/alili/web/">', 1)
    return web.Response(text=html, content_type="text/html", headers={"Cache-Control": "no-cache"})


# ───────────── 列表 / 目录树 / 封面 ─────────────
@routes.get("/alili/api/models")
async def api_models(req):
    kind = req.query.get("kind", "lora")
    if kind not in KINDS:
        return jerr("kind 无效")
    return web.json_response(await asyncio.to_thread(scan, kind))


def list_dirs(kind):
    """磁盘上所有子文件夹（相对各模型根目录，含空文件夹；跳过 . 开头的隐藏文件夹）"""
    out = set()
    for key in KINDS[kind]:
        for root in roots_of(key):
            for dp, dn, _ in os.walk(root, followlinks=True):
                dn[:] = [d for d in dn if not d.startswith(".")]
                if os.path.normpath(dp) != os.path.normpath(root):
                    out.add(os.path.relpath(dp, root).replace("\\", "/"))
    return out


@routes.get("/alili/api/tree")
async def api_tree(req):
    """文件夹目录树。默认只列含模型文件的文件夹（节点用）；带 all=1 时空文件夹也列出来（后台管理页用，数量为 0）"""
    kind = req.query.get("kind", "lora")
    items = await asyncio.to_thread(scan, kind)
    counts = {}
    if req.query.get("all") == "1":
        counts = {p: 0 for p in await asyncio.to_thread(list_dirs, kind)}
    for it in items:  # 只统计真正含模型文件的文件夹（父级一并计入）
        parts = it["folder"].split("/") if it["folder"] else []
        for i in range(1, len(parts) + 1):
            p = "/".join(parts[:i])
            counts[p] = counts.get(p, 0) + 1
    return web.json_response({"total": len(items), "folders": [{"path": p, "count": c} for p, c in sorted(counts.items())]})


@routes.get("/alili/api/cover")
async def api_cover(req):
    try:
        cov = find_cover(resolve(req.query["id"])[2])
    except Exception:
        return web.Response(status=404)
    return web.FileResponse(cov, headers={"Cache-Control": "no-cache"}) if cov else web.Response(status=404)


@routes.get("/alili/api/clip_map")
async def api_clip_map(_):
    return web.json_response(clip_map())


# ───────────── 编辑：元数据 / 重命名 / 删除 ─────────────
@routes.post("/alili/api/meta")
async def api_meta(req):
    d = await req.json()
    try:
        key, rel, full = resolve(d["id"])
    except Exception as e:
        return jerr(str(e), 404)
    p, meta = d.get("patch", {}), read_meta(full)
    if "title" in p:
        meta["model_name"] = str(p["title"]).strip()
    if "version" in p:
        meta.setdefault("civitai", {})["name"] = str(p["version"]).strip()
    if "base_model" in p:
        meta["base_model"] = str(p["base_model"]).strip()
    if "notes" in p:
        meta["notes"] = str(p["notes"])
    if "triggers" in p:
        meta.setdefault("civitai", {})["trainedWords"] = [str(w).strip() for w in p["triggers"] if str(w).strip()]
    for k in ("favorite", "exclude"):
        if k in p:
            meta[k] = bool(p[k])
    for k, add in (("ignore_version", True), ("unignore_version", False)):   # 忽略此更新（只记版本号，不动别的）
        if k in p and _int(p[k]) is not None:
            ign = [x for x in (meta.setdefault("alili", {}).get("ignored") or []) if _int(x) != _int(p[k])]
            meta["alili"]["ignored"] = ign + ([_int(p[k])] if add else [])
    write_meta(full, meta)
    item = item_of(key, rel, full)
    broadcast("alili.item", {"old_id": item["id"], "item": item})
    return web.json_response(item)


class RenameError(Exception):
    def __init__(self, msg, status=400):
        super().__init__(msg)
        self.status = status


WIN_RESERVED = {"con", "prn", "aux", "nul", *(f"com{i}" for i in range(1, 10)), *(f"lpt{i}" for i in range(1, 10))}


def _same(a, b):
    return os.path.normcase(os.path.realpath(a)) == os.path.normcase(os.path.realpath(b))


def rename_group(full, new):
    """模型 + 全部配套文件（元数据、元数据备份、各种格式的预览图/视频）一起改名；任何一步失败全部回滚。
    返回 (新模型路径, {旧路径: 新路径})"""
    folder, base = os.path.split(full)
    stem, ext = os.path.splitext(base)
    pairs = [(full, os.path.join(folder, new + ext))]
    pairs += [(p, os.path.join(folder, new + e)) for p, e in side_files(full)]
    for s_, t in pairs:
        if os.path.exists(t) and not _same(s_, t):  # 仅大小写不同的改名不算冲突
            raise RenameError(f"已存在同名文件：{os.path.basename(t)}", 409)
    done = []
    try:
        for s_, t in pairs:
            os.rename(s_, t)
            done.append((s_, t))
    except OSError as e:
        for s_, t in reversed(done):
            try:
                os.rename(t, s_)
            except OSError:
                pass
        raise RenameError(f"重命名失败（文件可能被占用）：{e}", 500)
    return pairs[0][1], dict(pairs)


def _pnorm(p):
    return os.path.normcase(os.path.normpath(str(p)))


def retarget_refs(old_id, new_id, new_rel, new_stem, old_stem=None):
    """改名后，把「自定义排序」和「样本」里引用旧名字的地方一起改掉（工作流里已保存的节点会通过 WebSocket 同步）"""
    order = load_json(ORDER, {})
    changed = False
    for k, ids in order.items():
        if isinstance(ids, list) and old_id in ids:
            order[k] = [new_id if i == old_id else i for i in ids]
            changed = True
    if changed:
        save_json(ORDER, order)
    samples, hit = load_samples(), False
    for smp in samples:
        for lst in ((smp.get("state") or {}).get("models") or [], (smp.get("state") or {}).get("loras") or []):
            for m in lst:
                if isinstance(m, dict) and m.get("id") == old_id:
                    m.update({"id": new_id, "name": new_rel, "file_name": new_stem})
                    hit = True
        g = smp.get("gen") or {}  # 从工作流里读到的模型 / LoRA 是按文件名记的
        if old_stem:
            g["models"] = [new_rel if norm(_stem(x)) == norm(old_stem) else x for x in g.get("models") or []]
            for x in g.get("loras") or []:
                if isinstance(x, dict) and norm(_stem(x.get("name", ""))) == norm(old_stem):
                    x["name"] = new_rel
            hit = hit or bool(old_stem)
    if hit:
        save_samples(samples)
        broadcast("alili.samples", {})


@routes.post("/alili/api/rename")
async def api_rename(req):
    d = await req.json()
    try:
        key, rel, full = resolve(d["id"])
    except Exception as e:
        return jerr(str(e), 404)
    new = str(d.get("new_name", "")).strip()
    if not new or BAD_NAME.search(new) or new.endswith(".") or new.split(".")[0].lower() in WIN_RESERVED:
        return jerr("文件名为空或含有非法字符")
    stem, ext = os.path.splitext(os.path.basename(full))
    if new == stem:
        return web.json_response({"id": d["id"], "item": item_of(key, rel, full)})
    try:
        new_full, moved = await asyncio.to_thread(rename_group, full, new)
    except RenameError as e:
        return jerr(str(e), e.status)
    meta = read_meta(new_full)
    if meta:  # 元数据里记的名字 / 路径 / 预览图路径也同步
        meta["file_name"] = new
        meta["file_path"] = new_full.replace("\\", "/")
        meta.setdefault("original_file_name", stem)  # 和参考插件一样，留一份原始下载名
        pu = meta.get("preview_url")
        if pu and _pnorm(pu) in {_pnorm(k) for k in moved}:
            meta["preview_url"] = next(t for k, t in moved.items() if _pnorm(k) == _pnorm(pu)).replace("\\", "/")
        elif find_cover(new_full) and not (pu and os.path.exists(pu)):
            meta["preview_url"] = find_cover(new_full).replace("\\", "/")
        write_meta(new_full, meta)
    new_rel = (os.path.dirname(rel) + "/" if os.path.dirname(rel) else "") + new + ext
    item = item_of(key, new_rel, new_full)
    retarget_refs(d["id"], item["id"], new_rel, new, stem)
    broadcast("alili.item", {"old_id": d["id"], "item": item})
    return web.json_response({"id": item["id"], "item": item})


def move_group(full, dest_dir):
    """模型 + 全部配套文件（元数据、元数据备份、预览图 / 视频）一起移到另一个文件夹；任何一步失败全部回滚。
    返回 (新模型路径, {旧路径: 新路径})"""
    pairs = [(full, os.path.join(dest_dir, os.path.basename(full)))]
    pairs += [(p, os.path.join(dest_dir, os.path.basename(p))) for p, _ in side_files(full)]
    for _, t in pairs:
        if os.path.exists(t):
            raise RenameError(f"目标文件夹里已经有同名文件：{os.path.basename(t)}", 409)
    os.makedirs(dest_dir, exist_ok=True)
    done = []
    try:
        for s_, t in pairs:
            shutil.move(s_, t)  # 同一个盘是改名，跨盘会先复制再删除
            done.append((s_, t))
    except (OSError, shutil.Error) as e:
        for s_, t in reversed(done):
            try:
                shutil.move(t, s_)
            except (OSError, shutil.Error):
                pass
        raise RenameError(f"移动失败（文件可能被占用）：{e}", 500)
    return pairs[0][1], dict(pairs)


@routes.post("/alili/api/move")
async def api_move(req):
    """把一张或多张卡片（模型 + 配套文件）移到同一个根目录下的某个文件夹；folder 为空 = 移到根目录"""
    d = await req.json()
    parts = [p for p in str(d.get("folder", "")).replace("\\", "/").split("/") if p]
    if any(p in (".", "..") or BAD_NAME.search(p) or p.endswith(".") or p.lower() in WIN_RESERVED for p in parts):
        return jerr("文件夹路径含有非法字符")
    rel_dir = "/".join(parts)
    moved, errors = [], []
    for item_id in d.get("ids") or []:
        try:
            key, rel, full = resolve(item_id)
        except Exception as e:
            errors.append(f"{item_id.split('|', 1)[-1]}：{e}")
            continue
        real_full = os.path.realpath(full)
        root = next((r for r in roots_of(key) if os.path.commonpath([os.path.realpath(r), real_full]) == os.path.realpath(r)), None)
        dest_dir = os.path.normpath(os.path.join(root, *parts)) if root else None
        if not root or os.path.commonpath([os.path.realpath(root), os.path.realpath(dest_dir)]) != os.path.realpath(root):
            errors.append(f"{os.path.basename(full)}：目标文件夹不在模型目录里")
            continue
        if _same(os.path.dirname(full), dest_dir):
            continue  # 已经在这个文件夹里
        stem = os.path.splitext(os.path.basename(full))[0]
        try:
            new_full, mv = await asyncio.to_thread(move_group, full, dest_dir)
        except RenameError as e:
            errors.append(f"{os.path.basename(full)}：{e}")
            continue
        meta = read_meta(new_full)
        if meta:  # 元数据里记的路径 / 预览图路径同步
            meta["file_path"] = new_full.replace("\\", "/")
            pu = meta.get("preview_url")
            if pu and _pnorm(pu) in {_pnorm(k) for k in mv}:
                meta["preview_url"] = next(t for k, t in mv.items() if _pnorm(k) == _pnorm(pu)).replace("\\", "/")
            elif find_cover(new_full) and not (pu and os.path.exists(pu)):
                meta["preview_url"] = find_cover(new_full).replace("\\", "/")
            write_meta(new_full, meta)
        new_rel = (rel_dir + "/" if rel_dir else "") + os.path.basename(full)
        item = item_of(key, new_rel, new_full)
        retarget_refs(item_id, item["id"], new_rel, stem, stem)  # 自定义排序 / 样本里引用的路径一起改
        broadcast("alili.item", {"old_id": item_id, "item": item})
        moved.append({"old_id": item_id, "item": item})
    return web.json_response({"items": moved, "errors": errors})


@routes.post("/alili/api/delete")
async def api_delete(req):
    d = await req.json()
    try:
        _, _, full = resolve(d["id"])
    except Exception as e:
        return jerr(str(e), 404)
    files = [full] + [p for p, _ in side_files(full)]
    try:
        from send2trash import send2trash as rm  # 有就进回收站，没有才永久删除
        trash = True
    except ImportError:
        rm, trash = os.remove, False
    for f in files:
        if f and os.path.exists(f):
            rm(f)
    broadcast("alili.item", {"removed": d["id"]})
    return web.json_response({"ok": True, "trash": trash})


# ───────────── 封面 ─────────────
@routes.post("/alili/api/cover")
async def api_cover_upload(req):  # 原生上传：multipart，字段 id + file
    from PIL import Image
    item_id, data = None, None
    async for part in await req.multipart():
        if part.name == "id":
            item_id = await part.text()
        elif part.name == "file":
            data = await part.read()
    try:
        key, rel, full = resolve(item_id)
        save_cover(full, Image.open(io.BytesIO(data)))
    except Exception as e:
        return jerr(f"封面保存失败：{e}")
    item = item_of(key, rel, full)
    broadcast("alili.item", {"old_id": item["id"], "item": item})
    return web.json_response({"ok": True, "item": item})


@routes.post("/alili/api/cover_from_output")
async def api_cover_output(req):  # 取工作流输出图：{id, filename, subfolder, type}
    d = await req.json()
    try:
        key, rel, full = resolve(d["id"])
        save_cover(full, output_image(d))
    except Exception as e:
        return jerr(f"封面保存失败：{e}")
    item = item_of(key, rel, full)
    broadcast("alili.item", {"old_id": item["id"], "item": item})
    return web.json_response({"ok": True, "item": item})


# ───────────── 样本 ─────────────
# ───────────── 样本存储：分类 = data 下的真实文件夹 ─────────────
#   data/Default/        没有分类的样本（以前的 data/samples 改名而来）
#   data/<分类名>/       每个分类一个文件夹，名字就是分类名
#   每个文件夹里：samples.json（这个文件夹里的样本）+ <样本id>.jpg（封面）
#   data/sample_cats.json 记分类的排列顺序；data/order.json 这类全局文件留在 data 外层
# 所以备份 / 恢复 / 搬家只要复制整个 data 文件夹；把别人的分类文件夹拷进 data 里，也会自动出现为一个分类
DEFAULT_DIR = "Default"
SAMPLE_CATS = os.path.join(DATA, "sample_cats.json")


def cat_dir(cat):
    return os.path.join(DATA, cat or DEFAULT_DIR)


def _cats():
    """分类列表（按保存的顺序）：文件夹被删掉的分类自然消失；手动拷进 data 里、带 samples.json 的文件夹也算分类"""
    saved = [x for x in load_json(SAMPLE_CATS, []) if isinstance(x, str)]
    out = [c for c in saved if os.path.isdir(cat_dir(c))]
    try:
        extra = sorted(n for n in os.listdir(DATA) if n not in out and n.casefold() != DEFAULT_DIR.casefold() and not n.startswith((".", "_"))
                       and os.path.isfile(os.path.join(DATA, n, "samples.json")))
    except OSError:
        extra = []
    out += extra
    if out != saved:
        save_json(SAMPLE_CATS, out)
    return out


def load_samples():
    """全部样本（每个分类文件夹各读一份）；category 由「它在哪个文件夹里」决定，不写进 json 里。新的在前"""
    out = []
    for c in [""] + _cats():
        for smp in load_json(os.path.join(cat_dir(c), "samples.json"), []):
            smp["category"] = c
            out.append(smp)
    out.sort(key=lambda x: -(x.get("created") or 0))
    return out


def save_samples(items):
    """按 category 把样本分别写回各自文件夹的 samples.json"""
    groups = {c: [] for c in [""] + _cats()}
    for smp in items:
        c = smp.get("category") or ""
        groups.setdefault(c if c in groups else "", []).append({k: v for k, v in smp.items() if k != "category"})
    for c, lst in groups.items():
        os.makedirs(cat_dir(c), exist_ok=True)
        save_json(os.path.join(cat_dir(c), "samples.json"), lst)


def sample_cover_path(sid, cat=""):
    return os.path.join(cat_dir(cat), os.path.basename(str(sid)) + ".jpg")


def find_sample_cover(sid):
    for c in [""] + _cats():
        p = sample_cover_path(sid, c)
        if os.path.exists(p):
            return p
    return None


def move_cover(sid, old, new):
    src = sample_cover_path(sid, old)
    if os.path.exists(src):
        os.makedirs(cat_dir(new), exist_ok=True)
        shutil.move(src, sample_cover_path(sid, new))


def _safe_cat(name):
    n = BAD_NAME.sub("_", str(name or "")).strip(" .")
    if not n or n.split(".")[0].lower() in WIN_RESERVED or n.casefold() == DEFAULT_DIR.casefold():
        return ""
    return n[:24]


def migrate_samples():
    """旧版存储（data/samples/ + 总的 data/samples.json）→ 新版（Default 和各分类文件夹）。只在发现旧文件时做一次，旧的总 json 留一份 .bak"""
    legacy_json, legacy_dir, default_dir = os.path.join(DATA, "samples.json"), os.path.join(DATA, "samples"), cat_dir("")
    try:
        if os.path.isdir(legacy_dir):  # data/samples → data/Default
            if not os.path.exists(default_dir):
                os.rename(legacy_dir, default_dir)
            else:
                for f in os.listdir(legacy_dir):
                    if not os.path.exists(os.path.join(default_dir, f)):
                        shutil.move(os.path.join(legacy_dir, f), os.path.join(default_dir, f))
                try:
                    os.rmdir(legacy_dir)
                except OSError:
                    pass
        os.makedirs(default_dir, exist_ok=True)
        if not os.path.isfile(legacy_json):
            return
        items = load_json(legacy_json, [])
        cats = []
        for c in load_json(SAMPLE_CATS, []):
            c = _safe_cat(c)
            if c and c not in cats:
                cats.append(c)
        by = {"": []}
        for smp in items:
            c = _safe_cat(smp.pop("category", ""))
            if c and c not in cats:
                cats.append(c)
            by.setdefault(c, []).append(smp)
        for c in cats:
            by.setdefault(c, [])
        for c, lst in by.items():
            d = cat_dir(c)
            os.makedirs(d, exist_ok=True)
            if c:  # 封面跟着样本去它的分类文件夹
                for smp in lst:
                    src = os.path.join(default_dir, smp["id"] + ".jpg")
                    if os.path.exists(src):
                        shutil.move(src, os.path.join(d, smp["id"] + ".jpg"))
            exist = load_json(os.path.join(d, "samples.json"), [])
            ids = {x["id"] for x in lst}
            save_json(os.path.join(d, "samples.json"), lst + [x for x in exist if x.get("id") not in ids])
        save_json(SAMPLE_CATS, cats)
        os.replace(legacy_json, legacy_json + ".bak")
        print(f"[Alili] 样本数据已迁移到文件夹存储：{len(items)} 个样本，{len(cats)} 个分类（旧的 samples.json 改名为 samples.json.bak，确认没问题后可以删掉）")
    except Exception as e:
        print(f"[Alili] 样本数据迁移失败（原数据没有被删除）：{e}")


migrate_samples()


def node_defs(class_type):
    """ComfyUI 自己的节点定义：{输入名: 类型}，让解析时能分清「提示词连线」和「模型 / 图像连线」"""
    import nodes
    t = nodes.NODE_CLASS_MAPPINGS[class_type].INPUT_TYPES()
    out = {}
    for sec in ("required", "optional"):
        for k, spec in (t.get(sec) or {}).items():
            ty = spec[0] if isinstance(spec, (list, tuple)) and spec else spec
            out[k] = "COMBO" if isinstance(ty, list) else str(ty)
    return out


def latest_run():
    """ComfyUI 历史记录里最近一次成功的运行：(节点参数 API 格式, 输出图 {filename, subfolder, type})；没有就 (None, None)"""
    try:
        hist = PromptServer.instance.prompt_queue.get_history(max_items=8)
    except Exception:
        return None, None
    for pid in reversed(list(hist)):
        h = hist[pid]
        try:
            prompt = h["prompt"][2]
        except Exception:
            continue
        st = (h.get("status") or {}).get("status_str")
        if st and st != "success":
            continue
        img = None
        for out in (h.get("outputs") or {}).values():
            for im in (out or {}).get("images") or []:
                if isinstance(im, dict) and im.get("filename") and im.get("type", "output") in ("output", "temp"):
                    img = {"filename": im["filename"], "subfolder": im.get("subfolder", ""), "type": im.get("type", "output")}
        return prompt, img
    return None, None


def capture_gen(fe_prompt=None):
    """读最近一次运行的参数；历史为空（比如刚重启过 ComfyUI）时，用前端传来的当前画布兜底。返回 (gen 或 None, 历史里的输出图)"""
    prompt, img = latest_run()
    src = prompt or (fe_prompt if isinstance(fe_prompt, dict) else None)
    if not src:
        return None, img
    try:
        g = capture.analyze(src, node_defs)
    except Exception as e:
        print(f"[Alili-Manager] 读取运行参数失败：{e}")
        return None, img
    return {**g, "source": "history" if prompt else "canvas"}, img


def _stem(name):
    b = re.split(r"[\\/]", str(name))[-1]
    return next((b[:-len(e)] for e in EXTS if b.lower().endswith(e)), b)


def lib_stems(kind):
    """本地模型库里所有文件的名字（不读元数据，很快）"""
    out = set()
    for key in KINDS[kind]:
        for root in roots_of(key):
            for _, _, files in os.walk(root, followlinks=True):
                out.update(norm(_stem(f)) for f in files if f.lower().endswith(EXTS))
    return out


def sample_view(smp, lib):
    """样本弹窗要显示的「用了什么模型 / LoRA，本地还在不在」。优先用工作流里读到的；没有就用保存时节点里选的"""
    gen, st = smp.get("gen") or {}, smp.get("state") or {}
    models = gen.get("models") or [m["name"] for m in st.get("models", []) if m.get("name")]
    loras = gen.get("loras") or [{"name": x["name"], "strength": x.get("w", 1)} for x in st.get("loras", []) if x.get("name")]
    return {
        "models": [{"name": n, "title": _stem(n), "local": norm(_stem(n)) in lib["model"]} for n in models],
        "loras": [{"name": x["name"], "title": _stem(x["name"]), "strength": x.get("strength", 1), "local": norm(_stem(x["name"])) in lib["lora"]} for x in loras],
    }


def with_views(items):
    lib = {"model": lib_stems("model"), "lora": lib_stems("lora")} if items else {}
    return [{**s, "view": sample_view(s, lib)} for s in items]


@routes.get("/alili/api/samples")
async def api_samples(_):
    return web.json_response(await asyncio.to_thread(lambda: with_views(load_samples())))


@routes.post("/alili/api/samples")
async def api_sample_add(req):  # {name, state, capture?:true, prompt?:当前画布, output?:{filename,subfolder,type}, cover_id?:大模型卡片id作兜底}
    d = await req.json()
    sid = uuid.uuid4().hex[:10]
    cat0 = str(d.get("category") or "").strip()
    cat0 = cat0 if cat0 in _cats() else ""  # 新样本默认放进 Default 文件夹
    gen, h_img = (await asyncio.to_thread(capture_gen, d.get("prompt"))) if d.get("capture") else (None, None)
    state = d.get("state", {})
    if not state.get("models") and not (gen and (gen["models"] or gen["prompt"])):
        return jerr("没有可保存的内容：先选一个大模型，或先运行一次工作流")
    cover, size = False, None
    try:
        from PIL import Image
        out = d.get("output") or h_img
        im = output_image(out) if out else None
        if im is not None:
            size = list(im.size)  # 实际出图尺寸（以图片为准，自适应画板也不会错）
        if im is None and d.get("cover_id"):
            c = find_cover(resolve(d["cover_id"])[2])
            im = Image.open(c) if c else None
        if im is not None:
            im = im.convert("RGB"); im.thumbnail((768, 768))
            os.makedirs(cat_dir(cat0), exist_ok=True)
            im.save(sample_cover_path(sid, cat0), "JPEG", quality=88)
            cover = True
    except Exception:
        pass
    smp = {"id": sid, "name": d.get("name") or "未命名样本", "state": state, "cover": cover, "created": int(time.time()), "category": cat0}
    if gen:
        smp["gen"] = {**gen, "size": size}
    elif size:
        smp["gen"] = {"prompt": "", "negative": "", "params": {}, "models": [], "loras": [], "size": size}
    items = load_samples()
    items.insert(0, smp)
    save_samples(items)
    broadcast("alili.samples", {})
    return web.json_response({"id": sid, "captured": bool(gen and (gen["prompt"] or gen["params"]))})


PARAM_TYPES = {"seed": int, "steps": int, "cfg": float, "denoise": float, "sampler": str, "scheduler": str}


@routes.post("/alili/api/sample_update")
async def api_sample_update(req):  # {id, patch:{name?, gen?:{prompt?, negative?, params?, size?}}}
    d = await req.json()
    items = load_samples()
    smp = next((x for x in items if x["id"] == d.get("id")), None)
    if not smp:
        return jerr("样本不存在", 404)
    patch = d.get("patch") or {}
    if isinstance(patch.get("name"), str) and patch["name"].strip():
        smp["name"] = patch["name"].strip()[:120]
    pg = patch.get("gen")
    if isinstance(pg, dict):
        g = smp.setdefault("gen", {"prompt": "", "negative": "", "params": {}, "models": [], "loras": [], "size": None})
        for k in ("prompt", "negative"):
            if isinstance(pg.get(k), str):
                g[k] = pg[k]
        if isinstance(pg.get("params"), dict):
            params = {}
            for k, v in pg["params"].items():
                if k in PARAM_TYPES and v not in (None, ""):
                    try:
                        params[k] = PARAM_TYPES[k](float(v)) if PARAM_TYPES[k] is int else PARAM_TYPES[k](v)
                    except (TypeError, ValueError):
                        pass
            g["params"] = params
        if "size" in pg:
            m = re.fullmatch(r"\s*(\d+)\s*[x×*,，]\s*(\d+)\s*", str(pg["size"] or ""))
            g["size"] = [int(m.group(1)), int(m.group(2))] if m else None
    save_samples(items)
    broadcast("alili.samples", {})
    return web.json_response({"item": (await asyncio.to_thread(lambda: with_views([smp])))[0]})


@routes.delete("/alili/api/samples")
async def api_sample_del(req):
    sid = req.query.get("id", "")
    items = load_samples()
    smp = next((x for x in items if x["id"] == sid), None)
    save_samples([x for x in items if x["id"] != sid])
    p = sample_cover_path(sid, smp.get("category", "")) if smp else None
    if p and os.path.exists(p):
        os.remove(p)
    broadcast("alili.samples", {})
    return web.json_response({"ok": True})


# ───────────── 样本分类接口：分类 = data 下的真实文件夹（存储细节见上面「样本存储」）─────────────
def _cat_err(name, cats, old=None):
    if (not name or len(name) > 24 or BAD_NAME.search(name) or name.endswith((".", " "))
            or name.split(".")[0].lower() in WIN_RESERVED):
        return "分类名称不能为空，最长 24 个字，不能含有 \\ / : * ? \" < > | 这些字符（它会变成 data 文件夹里的文件夹名）"
    if name.casefold() == DEFAULT_DIR.casefold():
        return "Default 是没有分类的样本的默认文件夹，请换一个名字"
    if any(c.casefold() == name.casefold() and c != old for c in cats):
        return "已经有这个分类了"
    p = cat_dir(name)
    if os.path.exists(p) and not os.path.isdir(p):
        return "data 文件夹里已经有同名的文件了"
    return None


@routes.get("/alili/api/sample_cats")
async def api_sample_cats(_):
    return web.json_response({"cats": await asyncio.to_thread(_cats)})


@routes.post("/alili/api/sample_cats")
async def api_sample_cats_edit(req):  # {action: add | rename | delete | reorder, name, new_name?, names?}
    d = await req.json()
    act, name = d.get("action"), str(d.get("name", "")).strip()
    cats = _cats()
    try:
        if act == "reorder":  # 调整分类顺序：names 必须正好是现有全部分类（只是换了顺序）
            names = [str(x) for x in d.get("names") or []]
            if sorted(names) != sorted(cats):
                return jerr("分类列表已变化，请刷新后再试", 409)
            cats = names
        elif act == "add":  # 新建分类 = 在 data 下新建同名文件夹
            err = _cat_err(name, cats)
            if err:
                return jerr(err)
            os.makedirs(cat_dir(name), exist_ok=True)
            if not os.path.exists(os.path.join(cat_dir(name), "samples.json")):
                save_json(os.path.join(cat_dir(name), "samples.json"), [])
            cats.append(name)
        elif act == "rename":  # 重命名分类 = 重命名文件夹
            if name not in cats:
                return jerr("分类不存在", 404)
            new = str(d.get("new_name", "")).strip()
            err = _cat_err(new, cats, old=name)
            if err:
                return jerr(err)
            if new != name:
                src, dst = cat_dir(name), cat_dir(new)
                if os.path.exists(dst) and not _same(src, dst):
                    return jerr("data 文件夹里已经有同名文件夹了", 409)
                os.rename(src, dst)
                cats = [new if c == name else c for c in cats]
        elif act == "delete":  # 删除分类：里面的样本（和封面）搬回 Default，不会被删除；分类文件夹只有空了才删
            if name not in cats:
                return jerr("分类不存在", 404)
            items = load_samples()
            for smp in items:
                if smp.get("category") == name:
                    move_cover(smp["id"], name, "")
                    smp["category"] = ""
            sj = os.path.join(cat_dir(name), "samples.json")
            if os.path.exists(sj):
                os.remove(sj)
            cats = [c for c in cats if c != name]
            save_json(SAMPLE_CATS, cats)
            try:
                os.rmdir(cat_dir(name))
            except OSError:
                pass  # 里面还有别的文件就留着，但没有 samples.json 就不再算分类
            save_samples(items)
        else:
            return jerr("action 无效")
    except OSError as e:
        return jerr(f"文件夹操作失败（可能被占用）：{e}", 500)
    save_json(SAMPLE_CATS, cats)
    broadcast("alili.samples", {})
    return web.json_response({"cats": cats})


@routes.post("/alili/api/sample_move")
async def api_sample_move(req):  # {ids: [...], category: "" | 分类名}；样本 + 封面一起搬到那个文件夹，"" = Default
    d = await req.json()
    cat = str(d.get("category", "")).strip()
    if cat and cat not in _cats():
        return jerr("分类不存在", 404)
    ids, items, n, err = set(d.get("ids") or []), load_samples(), 0, None
    try:
        for smp in items:
            if smp["id"] in ids and (smp.get("category") or "") != cat:
                move_cover(smp["id"], smp.get("category") or "", cat)
                smp["category"] = cat
                n += 1
    except OSError as e:
        err = e
    if n:
        save_samples(items)
        broadcast("alili.samples", {})
    if err:
        return jerr(f"移动失败（文件可能被占用）：{err}", 500)
    return web.json_response({"moved": n})


@routes.get("/alili/api/sample_cover")
async def api_sample_cover(req):
    p = find_sample_cover(req.query.get("id", ""))
    return web.FileResponse(p) if p else web.Response(status=404)


# ───────────── 网页 ⇄ 节点 联动（经 ComfyUI 自带的 WebSocket 广播） ─────────────
@routes.post("/alili/api/send")
async def api_send(req):  # 网页「发送到工作流」：{mode: append|replace, items:[...], node_id?}
    broadcast("alili.send", await req.json())
    return web.json_response({"ok": True})


@routes.post("/alili/api/state")
async def api_state(req):  # 节点选择变化后回报，网页据此同步高亮
    broadcast("alili.state", await req.json())
    return web.json_response({"ok": True})


@routes.get("/alili/api/settings")
async def api_settings_get(_):
    s = settings()
    s["api_key"] = "***" if s["api_key"] else ""
    return web.json_response(s)


@routes.post("/alili/api/settings")
async def api_settings_set(req):
    d, s = await req.json(), settings()
    for k in ("civitai_base", "proxy"):
        if k in d:
            s[k] = str(d[k]).strip()
    if d.get("api_key") not in (None, "***"):
        s["api_key"] = str(d["api_key"]).strip()
    save_json(os.path.join(DATA, "settings.json"), s)
    return web.json_response({"ok": True})


# ───────────── 单个条目 / 基础模型维护表 / 打开位置 ─────────────
@routes.get("/alili/api/item")
async def api_item(req):
    try:
        key, rel, full = resolve(req.query["id"])
    except Exception as e:
        return jerr(str(e), 404)
    return web.json_response(item_of(key, rel, full))


@routes.get("/alili/api/base_models")
async def api_base_get(_):
    return web.json_response(base_table())


@routes.post("/alili/api/base_models")
async def api_base_add(req):  # 下拉里找不到时可以直接添加：{name, badge?, family?}
    d, table = await req.json(), base_table()
    name = str(d.get("name", "")).strip()
    if not name:
        return jerr("名称不能为空")
    if not any(norm(e["name"]) == norm(name) for e in table):
        table.append({"name": name, "family": d.get("family", ""), "badge": (d.get("badge") or name).strip()})
        table.sort(key=lambda e: e["name"].lower())
        save_json(os.path.join(ROOT, "base_models.json"), table)
    return web.json_response(table)


@routes.post("/alili/api/reveal")
async def api_reveal(req):  # 打开模型所在位置，并选中文件
    d = await req.json()
    try:
        full = os.path.normpath(resolve(d["id"])[2])
    except Exception as e:
        return jerr(str(e), 404)
    if sys.platform.startswith("win"):
        subprocess.Popen(["explorer", "/select," + full])
    elif sys.platform == "darwin":
        subprocess.Popen(["open", "-R", full])
    else:
        subprocess.Popen(["xdg-open", os.path.dirname(full)])
    return web.json_response({"ok": True})


# ───────────── 图标清单 / 自定义排序 ─────────────
@routes.get("/alili/api/icons")
async def api_icons(_):  # 前端据此判断图标文件在不在，不在就用文字符号兜底
    d = os.path.join(IMAGES, "svg")
    return web.json_response({f[:-4]: True for f in os.listdir(d) if f.lower().endswith(".svg")})


ORDER = os.path.join(DATA, "order.json")


@routes.get("/alili/api/order")
async def api_order_get(_):
    return web.json_response(load_json(ORDER, {}))


@routes.post("/alili/api/order")
async def api_order_set(req):  # {kind, ids:[...]}：后台拖拽排序后保存
    d = await req.json()
    if d.get("kind") not in KINDS or not isinstance(d.get("ids"), list):
        return jerr("参数无效")
    data = load_json(ORDER, {})
    data[d["kind"]] = [str(i) for i in d["ids"]]
    save_json(ORDER, data)
    return web.json_response({"ok": True})


# ───────────── CivitAI：拉取数据 / 检查更新 在 civitai.py ─────────────
# 放在文件最后 import：civitai.py 要从本文件取公用函数，必须等它们都定义完。import 时它里面的接口会自动注册。
from . import civitai  # noqa: E402,F401
