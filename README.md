本地聊天平台

说明
- 轻量的本地实时聊天室，基于 Python + aiohttp。前端为单页静态 HTML/CSS/JS。

依赖
- Python 3.8+
- aiohttp

安装（PowerShell）

pip install -r requirements.txt

运行
$env:ZHIPU_API_KEY="此处填写apikey"
python main.py

本地：在浏览器打开 http://127.0.0.1:8080 ，输入名字进入聊天室。
局域网：将监听地址改为web.run_app(app, host='0.0.0.0', port=port)
可在ip地址加端口号访问，如 http://10.29.100.117:端口
