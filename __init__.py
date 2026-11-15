"""Alili-Manager —— 作者：阿里里
节点：Alili模型管理器　后台：http://localhost:8188/Manager
注意：ComfyUI 会自动加载 WEB_DIRECTORY 下的全部 .js，所以这里只放节点脚本 ext/node.js，
后台页面的资源放在 web/，由 server.py 单独提供（/alili/web/...）。"""
from .nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS
from . import server  # noqa: F401  注册后台路由

WEB_DIRECTORY = "./ext"
__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
