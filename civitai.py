"""Alili-Manager —— CivitAI（C 站）相关：拉取数据 / 检查更新 都在这个文件里。

  · civ_session / civ_get / civ_bytes     请求 CivitAI（代理、证书、重试、civitai.com ⇄ civitai.red 自动切换、下载封面）
  · /alili/api/civitai_refresh            拉取数据：把一张卡片和 CivitAI 对上并同步元数据 / 封面 / 触发词
  · /alili/api/check_update               检查更新：{id} 查一张；{ids: [...]} 查一组（网页把同一个 CivitAI 模型的所有文件放一起发）

批量拉取 / 批量检查更新由网页逐个驱动（一次请求一个，进度条也在网页里数）：关掉页面、点进度条上的 ✕，任务就停，后端没有后台任务。
由 server.py 在末尾 import 本文件，接口就会自动注册。
本文件用到的公用函数（读写元数据、封面、扫描、广播……）还放在 server.py 里，下面从 .server 取。
"""
import asyncio
import hashlib
import io
import os
import shutil
import time

from aiohttp import web, ClientSession, ClientTimeout, TCPConnector

from .server import (  # noqa: E402  server.py 在末尾才 import 本文件，所以这些名字此时都已经定义好了
    _int, broadcast, creator_of, find_cover, item_of, jerr, norm_versions, read_meta, resolve, routes,
    save_cover, settings, sidecar, write_meta,
)

_SSL = {"system": False}  # certifi 验证失败过一次后，改用系统证书库（杀毒 / 公司网络会替换证书）


def civ_session(total=30):
    """和参考插件的下载器同样的网络设置：自动使用系统 / 环境变量代理（trust_env），带 User-Agent，
    优先用 certifi 证书，关掉 netrc 自动认证。只有在 settings.json 里手动填了 proxy 才改用手动代理。"""
    import ssl
    s = settings()
    try:
        if _SSL["system"]:
            raise ImportError
        import certifi
        ctx = ssl.create_default_context(cafile=certifi.where())
    except Exception:
        ctx = ssl.create_default_context()
    sess = ClientSession(
        connector=TCPConnector(ssl=ctx, ttl_dns_cache=300), trust_env=not s["proxy"],
        timeout=ClientTimeout(total=total, connect=30),
        headers={"User-Agent": "ComfyUI-LoRA-Manager/1.0"},
    )
    setattr(sess, "_get_netrc_auth", lambda *a, **k: None)
    return sess


class CivError(Exception):
    def __init__(self, msg, status=502, rate=False):
        super().__init__(msg)
        self.status, self.rate = status, rate


ALT_BASE = {"https://civitai.red": "https://civitai.com", "https://civitai.com": "https://civitai.red"}


async def civ_get(path, retries=2):
    """请求 CivitAI API（不需要 API Key）：429 / 5xx / 网络抖动自动重试；主域名连不上时自动换另一个域名；错误给出明确提示"""
    s = settings()
    hdr = {"Authorization": "Bearer " + s["api_key"]} if s["api_key"] else {}
    base = s["civitai_base"].rstrip("/")
    bases, last = [base] + ([ALT_BASE[base]] if base in ALT_BASE else []), None
    for b in bases:
        for i in range(retries + 1):
            try:
                async with civ_session() as sess:
                    async with sess.get(b + path, headers=hdr, proxy=s["proxy"] or None) as r:
                        if r.status == 404:
                            return None
                        if r.status in (401, 403):
                            raise CivError(f"CivitAI 拒绝访问（{r.status}）：该模型可能需要登录才能查看", 401)
                        if r.status == 429 or r.status >= 500:
                            try:
                                wait = min(float(r.headers.get("Retry-After", 2 * (i + 1))), 20)
                            except ValueError:
                                wait = 2 * (i + 1)
                            last = CivError("CivitAI 请求太频繁，被限流了，请稍后再试" if r.status == 429 else f"CivitAI 服务器错误（{r.status}）", 429 if r.status == 429 else 502, rate=r.status == 429)
                            if i < retries:
                                await asyncio.sleep(wait)
                                continue
                            raise last
                        if r.status >= 400:
                            raise CivError(f"CivitAI 返回 {r.status}")
                        return await r.json(content_type=None)
            except CivError:
                raise
            except Exception as e:
                if "CERTIFICATE_VERIFY_FAILED" in str(e) and not _SSL["system"]:
                    _SSL["system"] = True  # 换系统证书库，不消耗重试次数
                    try:
                        async with civ_session() as sess:
                            async with sess.get(b + path, headers=hdr, proxy=s["proxy"] or None) as r:
                                if r.status == 200:
                                    return await r.json(content_type=None)
                    except Exception:
                        pass
                last = CivError(f"连不上 CivitAI（{type(e).__name__}: {e}）：请检查网络 / 代理（会自动使用系统代理，也可在 data/settings.json 里设置 proxy）")
                if i < retries:
                    await asyncio.sleep(1 + i)
                    continue
                break  # 这个域名不行，换下一个
    raise last


def sha256_of(full):
    h = hashlib.sha256()
    with open(full, "rb") as f:
        for chunk in iter(lambda: f.read(8 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


async def civ_bytes(url):
    s = settings()
    async with civ_session(60) as sess:
        async with sess.get(url, proxy=s["proxy"] or None) as r:
            r.raise_for_status()
            return await r.read()


def user_changes(meta, ver, mdl):
    """和 CivitAI 原始数据对比，找出用户手动改过的内容（没改过就不用提示）"""
    if not meta:
        return []
    civ, out = meta.get("civitai") or {}, []
    title = (ver.get("model") or {}).get("name") or mdl.get("name")
    if meta.get("model_name") and title and meta["model_name"] != title:
        out.append("标题")
    if civ and (civ.get("name") or "") != (ver.get("name") or ""):
        out.append("版本")
    if meta.get("base_model") and meta["base_model"] != (ver.get("baseModel") or ""):
        out.append("基础模型")
    if civ and (civ.get("trainedWords") or []) != (ver.get("trainedWords") or []):
        out.append("触发词")
    if meta.get("notes"):
        out.append("备注")
    if (meta.get("alili") or {}).get("cover_src") == "custom":
        out.append("封面")
    return out


@routes.post("/alili/api/civitai_refresh")
async def api_civ_refresh(req):
    """流程：拉取（先把网络数据全拿到）→ 若用户改过内容且未确认(force)就返回 need_confirm →
    确认后用 CivitAI 数据重新生成 metadata（旧文件留 .bak）；新封面下载失败时保留旧封面，不会白白丢图。
    收藏 / 拉黑状态保留。"""
    d = await req.json()
    try:
        key, rel, full = resolve(d["id"])
    except Exception as e:
        return jerr(str(e), 404)
    old = read_meta(full)
    try:
        size = os.path.getsize(full)
        sha = old.get("sha256") if old.get("sha256") and old.get("size", size) == size else None
        sha = sha or await asyncio.to_thread(sha256_of, full)
        ver = await civ_get(f"/api/v1/model-versions/by-hash/{sha}")
        if not ver:
            return jerr("CivitAI 上没有找到这个模型（可能已被作者删除，或文件被改动过）", 404)
        mdl = await civ_get(f"/api/v1/models/{ver['modelId']}") or {}
        if not d.get("force"):
            changes = user_changes(old, ver, mdl)
            if changes:
                return web.json_response({"need_confirm": True, "changes": changes})
        im = None
        img_url = next((i["url"] for i in ver.get("images", []) if i.get("type", "image") == "image" and i.get("url")), None)
        if img_url:
            try:  # 下载并确认图片能打开，之后才动本地文件
                from PIL import Image
                im = Image.open(io.BytesIO(await civ_bytes(img_url)))
                im.load()
            except Exception:
                im = None
    except CivError as e:
        return jerr(str(e), e.status)
    except Exception as e:
        return jerr(f"拉取失败：{e}", 500)

    old_cover = find_cover(full)
    keep_cover = bool(old_cover) and im is None
    civ = dict(ver)
    civ["model"] = {**(ver.get("model") or {}), "description": mdl.get("description", ""), "tags": mdl.get("tags", [])}
    new_meta = {
        "model_name": civ["model"].get("name") or mdl.get("name") or os.path.splitext(os.path.basename(full))[0],
        "sha256": sha, "base_model": ver.get("baseModel", ""), "notes": "", "from_civitai": True, "civitai": civ,
        "tags": mdl.get("tags", []), "modelDescription": mdl.get("description", ""), "metadata_source": "civitai_api",
        "favorite": bool(old.get("favorite")), "exclude": bool(old.get("exclude")), "usage_tips": "{}",
        "last_checked_at": time.time(),
        "alili": {"versions": norm_versions(mdl), "creator": creator_of(mdl), "checked_at": int(time.time())},
    }
    if (old.get("alili") or {}).get("ignored"):
        new_meta["alili"]["ignored"] = old["alili"]["ignored"]
    if keep_cover:  # 没拿到新图：沿用旧封面及其来源标记
        new_meta["preview_url"] = old_cover.replace("\\", "/")
        if (old.get("alili") or {}).get("cover_src"):
            new_meta["alili"]["cover_src"] = old["alili"]["cover_src"]
    try:
        if os.path.exists(sidecar(full)):
            shutil.copy2(sidecar(full), sidecar(full) + ".bak")
        write_meta(full, new_meta)
        if im is not None:
            save_cover(full, im, "civitai")
    except Exception as e:
        return jerr(f"写入本地文件失败：{e}", 500)
    item = item_of(key, rel, full)
    broadcast("alili.item", {"old_id": item["id"], "item": item})
    return web.json_response({"item": item})


@routes.post("/alili/api/civitai_triggers")
async def api_civ_triggers(req):
    """只拉触发词：按本地记录的版本号请求这一个版本（没有记录就按文件哈希找），只返回触发词，不改任何本地文件——
    网页把它填进输入框，用户点「保存」才会写入。"""
    d = await req.json()
    try:
        key, rel, full = resolve(d["id"])
    except Exception as e:
        return jerr(str(e), 404)
    try:
        vid = _int((read_meta(full).get("civitai") or {}).get("id"))
        if vid:
            ver = await civ_get(f"/api/v1/model-versions/{vid}")
        else:
            old = read_meta(full)
            sha = old.get("sha256") or await asyncio.to_thread(sha256_of, full)
            ver = await civ_get(f"/api/v1/model-versions/by-hash/{sha}")
    except CivError as e:
        return jerr(str(e), e.status)
    except Exception as e:
        return jerr(f"拉取失败：{e}", 500)
    if not ver:
        return jerr("CivitAI 上没有找到这个模型版本", 404)
    return web.json_response({"words": [str(w).strip() for w in ver.get("trainedWords") or [] if str(w).strip()]})


async def check_models(entries):
    """entries = [(key, rel, full)]；同一个 CivitAI 模型（多个文件/版本）只请求一次。返回 (已检查数, 发现更新数, 失败数, 跳过数, 限流中止)"""
    by_model, skipped = {}, 0
    for key, rel, full in entries:
        mid = _int(((read_meta(full).get("civitai") or {}).get("modelId")))
        if mid:
            by_model.setdefault(mid, []).append((key, rel, full))
        else:
            skipped += 1
    checked = found = failed = 0
    stopped = False
    for mid, group in by_model.items():
        try:
            mdl = await civ_get(f"/api/v1/models/{mid}")
            if mdl is None:
                failed += len(group)
                continue
            versions = norm_versions(mdl)
        except CivError as e:
            failed += len(group)
            if e.rate:
                stopped = True
                break
            continue
        for key, rel, full in group:
            meta = read_meta(full)
            meta.setdefault("alili", {}).update({"versions": versions, "creator": creator_of(mdl), "checked_at": int(time.time())})
            write_meta(full, meta)
            item = item_of(key, rel, full)
            broadcast("alili.item", {"old_id": item["id"], "item": item})
            checked += 1
            found += 1 if item["update"] else 0
    return checked, found, failed, skipped, stopped


@routes.post("/alili/api/check_update")
async def api_check_update(req):
    """检查更新。{id}：只查这一张（出错会直接报错）；{ids: [...]}：查一组，没有 CivitAI 数据的跳过，不报错。
    同一个 CivitAI 模型（多个文件 / 版本）只请求一次。返回 items = 这一组最新的卡片数据，网页拿去刷新卡片。"""
    d = await req.json()
    single = d.get("id")
    entries, skipped = [], 0
    for i in ([single] if single else d.get("ids") or []):
        try:
            key, rel, full = resolve(i)
        except Exception as e:
            if single:
                return jerr(str(e), 404)
            skipped += 1
            continue
        if not ((read_meta(full).get("civitai") or {}).get("modelId")):
            if single:
                return jerr("请先点「刷新 CivitAI 数据」", 409)
            skipped += 1
            continue
        entries.append((key, rel, full))
    try:
        checked, found, failed, _, stopped = await check_models(entries) if entries else (0, 0, 0, 0, False)
    except Exception as e:
        return jerr(f"检查失败：{e}", 500)
    items = [item_of(k, r, f) for k, r, f in entries]
    if single:
        if not checked:
            return jerr("检查失败：没有读到版本列表（模型可能已从 CivitAI 删除，或网络 / 限流问题）", 502)
        return web.json_response({"item": items[0], "has_update": items[0]["update"], "latest": items[0]["latest"]})
    return web.json_response({"items": items, "checked": checked, "found": found, "failed": failed, "skipped": skipped, "stopped": stopped})
