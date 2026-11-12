"""Alili模型管理器：没有输入口，只输出 模型 + 触发词。
大模型卡片就是模型加载器；CLIP / VAE 在工作流里另外接，和本节点无关。
选择状态由前端写进隐藏的 state（JSON），格式：
{"multi":{"lora":false,"model":false},
 "models":[{"key":"diffusion_models","name":"Qwen-Image/x.safetensors","dtype":"default"}],
 "loras":[{"name":"Flux2/y.safetensors","w":1.0}]}"""
import json
import os

import torch
import folder_paths
import comfy.sd
import comfy.utils

DTYPES = ["default", "fp8_e4m3fn", "fp8_e4m3fn_fast", "fp8_e5m2"]
_lora_cache = {}  # full_path -> (mtime, state_dict)


def _load_lora(path):
    mtime = os.path.getmtime(path)
    hit = _lora_cache.get(path)
    if hit and hit[0] == mtime:
        return hit[1]
    data = comfy.utils.load_torch_file(path, safe_load=True)
    _lora_cache.clear()  # 只缓存最近一批，避免占内存
    _lora_cache[path] = (mtime, data)
    return data


def _triggers(full_path):
    meta = os.path.splitext(full_path)[0] + ".metadata.json"
    try:
        with open(meta, encoding="utf-8") as f:
            return [w.strip() for w in (json.load(f).get("civitai") or {}).get("trainedWords") or [] if w.strip()]
    except Exception:
        return []


def _load_model(m):
    key, name = m.get("key", "diffusion_models"), m["name"]
    path = folder_paths.get_full_path(key, name)
    if not path:
        raise FileNotFoundError(f"Alili模型管理器：找不到大模型 {name}")
    if key == "checkpoints":
        return comfy.sd.load_checkpoint_guess_config(
            path, output_vae=False, output_clip=False,
            embedding_directory=folder_paths.get_folder_paths("embeddings"))[0]
    opts, dtype = {}, m.get("dtype", "default")
    if dtype == "fp8_e4m3fn":
        opts["dtype"] = torch.float8_e4m3fn
    elif dtype == "fp8_e4m3fn_fast":
        opts["dtype"] = torch.float8_e4m3fn
        opts["fp8_optimizations"] = True
    elif dtype == "fp8_e5m2":
        opts["dtype"] = torch.float8_e5m2
    return comfy.sd.load_diffusion_model(path, model_options=opts)


class AliliModelManager:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"state": ("STRING", {"default": "{}"})}}  # 前端隐藏，用户不直接编辑

    RETURN_TYPES = ("MODEL", "STRING")
    RETURN_NAMES = ("模型", "触发词")
    OUTPUT_IS_LIST = (True, True)  # 大模型多选时，下游采样器会对每个模型各跑一次
    FUNCTION = "run"
    CATEGORY = "Alili"

    @classmethod
    def IS_CHANGED(cls, state):
        return state

    def run(self, state):
        st = json.loads(state or "{}")
        multi = st.get("multi", {})
        models = st.get("models", [])
        loras = st.get("loras", [])
        if not models:
            raise ValueError("Alili模型管理器：请先选择一个大模型卡片")
        if not multi.get("model"):
            models = models[-1:]
        if not multi.get("lora"):
            loras = loras[-1:]

        patches, words = [], []
        for l in loras:
            w = float(l.get("w", 1.0))
            path = folder_paths.get_full_path("loras", l["name"])
            if not path:
                raise FileNotFoundError(f"Alili模型管理器：找不到 LoRA {l['name']}")
            for t in _triggers(path):
                if t not in words:
                    words.append(t)
            if w != 0:
                patches.append((_load_lora(path), w))
        trigger = ", ".join(words)

        outs = []
        for m in models:
            model = _load_model(m)
            for data, w in patches:  # 只作用于模型；CLIP 在外部，LoRA 的文本编码器部分不会生效
                model = comfy.sd.load_lora_for_models(model, None, data, w, 0)[0]
            outs.append(model)
        return (outs, [trigger] * len(outs))


NODE_CLASS_MAPPINGS = {"AliliModelManager": AliliModelManager}
NODE_DISPLAY_NAME_MAPPINGS = {"AliliModelManager": "Alili模型管理器"}
