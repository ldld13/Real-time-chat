本地聊天平台

说明
- 轻量的本地实时聊天室，基于 Python + aiohttp。前端为单页静态 HTML/CSS/JS。

依赖
- Python 3.8+
- aiohttp

安装（PowerShell）

```
pip install -r requirements.txt
```

运行
- 设置智谱 API Key（必需）：
```
$env:ZHIPU_API_KEY="你的apikey"
```
- 启动服务（默认 127.0.0.1:8080）：
```
python main.py
```
- 浏览器访问 http://127.0.0.1:8080 输入名字进入聊天室。

局域网演示
- 修改监听地址为 0.0.0.0 以允许局域网访问：
  - 在 `main.py` 中将 `web.run_app(app, host='0.0.0.0', port=port)`（或启动时添加 `--host 0.0.0.0` 参数，如果已支持）。
- 局域网其他设备访问：用本机 IP 替换为你的地址，例如 http://10.29.100.117:8080（端口与启动一致）。

常见问题
- 提示 `ZHIPU_API_KEY not set`：确认已在当前 PowerShell 会话执行 `$env:ZHIPU_API_KEY="你的apikey"`，且启动命令在同一会话运行。


github链接
https://github.com/ldld13/Real-time-chat
