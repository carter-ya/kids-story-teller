# 晚安邮局

家长写故事、听审 AI 朗读并发布到孩子的私人书架。[产品方案](docs/product-design.md)和[概念交互图](docs/interaction-map.html)记录页面与交互约定。声音体验与技术实现分别见[声音产品文档](docs/voice-product.md)和[声音技术文档](docs/voice-architecture.md)。

## 运行云端家庭版

使用 Node.js 22.13+ 和 npm。首次启动执行以下命令。开发密钥只生成一次并妥善保管；更换会导致此前加密的服务商密钥无法解密。

```sh
npm ci
(umask 077; set -C; node -e "console.log('VAULT_KEY=' + require('crypto').randomBytes(32).toString('hex'))" > .dev.vars)
npm run db:local
npm run dev
```

打开 Wrangler 显示的地址，创建家庭，把家庭登录码存进密码管理器。在「我的家庭 → 模型与声音」连接 OpenAI 或 DeepSeek，选择写作模型或使用配音预设，先试听再生成全篇。可以直接导入自己的稿件。家庭登录码授予完整管理权限；把设备交给孩子前，点「交给孩子」。

Workers 提供同源 API，D1 保存家庭、会话、任务和加密后的凭据，私有 R2 保存书架及 WAV 录音，Queues 执行写作和配音。每个家庭最多 20 人、100 篇故事、100 MB。单次书架 JSON 请求限 8 MB，单篇配音最多 4000 字、32 MB。后台会回收未引用的录音，临时试听至少保留一天。不同设备同时编辑时页面提示版本冲突，可先导出稿件再重新加载。

## 部署到 Cloudflare

在目标账户创建 D1 数据库 `story-families`、R2 存储桶 `story-family-files` 和队列 `story-narration`，在自己的部署配置中填写 D1 的 `database_id`。使用 `npx wrangler secret put VAULT_KEY` 设置单独生成的 64 位十六进制密钥。运行 `npx wrangler d1 migrations apply DB --remote` 后执行 `npx wrangler deploy`。以 HTTPS 访问站点，保持 R2 私有。仓库配置不含账号标识、家庭登录码或服务商密钥。

平台开销取决于账号总用量，100 MB 是单个家庭的应用额度。Queues 和 R2 各有免费用量，写作和配音由家长的服务商账户独立计费。[Queues 价格](https://developers.cloudflare.com/queues/platform/pricing/) · [R2 价格](https://developers.cloudflare.com/r2/pricing/)

## 验证

```sh
npm test
npm run test:worker
node tests/frontend-smoke.mjs http://127.0.0.1:8787/ --cloud
```

云端浏览器测试创建一个独立测试家庭，验证引导、草稿持久化、孩子权限及家长重新登录。协议测试模拟供应商的成功和中断响应，真实听感仍需使用自己的 Key 试听。

## 单独运行静态前端体验

在项目根目录使用 Python 3 启动静态站点。应用无需安装包或构建。

```sh
python3 -m http.server 8000 --bind 127.0.0.1 --directory web
```

在浏览器打开 `http://127.0.0.1:8000/`。访客可在首页直接试听，家长登录后按五个实际操作完成首次引导。登录和家长区评审口令为 `1234`。同一浏览器和站点地址下的数据存于 IndexedDB，切换听众可检查各自的书架、收藏与进度。

## 静态体验范围

- 书架有三篇带普通话录音的原创绘本，支持播放、拖动、续听、收藏和定时停止。
- 进入家长区后可写作、导入文本、改稿、管理版本、选择声音、发布给指定孩子，也可撤回、归档、导出和删除作品。
- 文字生成使用本地示例逻辑。自创故事使用浏览器可用的中文系统语音朗读，语音可用性取决于设备。内置绘本使用独立音频文件。
- 服务商配置支持预演地址、模型和密钥输入。密钥不会发送或写入存储。家长口令、家庭成员、额度预留均为界面评审用途。云端家庭版使用上面的 Workers 启动方式。

## 目录与验证

`web/index.html` 为入口。书架与本地状态在 `app.js`，播放器、创作台、家庭设置分别在 `player.js`、`studio.js`、`family.js`。全站下拉使用 `picker.js`。示例故事正文及录音索引在 `web/samples.js`，录音与绘本封面在 `web/assets/`。三篇内置故事使用本机增强普通话音色重新制作，保留对白与段落停顿。使用已安装相应音色的 macOS、Xcode Command Line Tools 和 Python 3.12+，可运行 `python3 tools/render_samples.py` 重新生成并验证录音。

使用 Node.js 22.4+（内置 WebSocket）和 Chrome，先启动上面的本地服务，再从根目录运行浏览器回归测试。macOS 默认使用标准 Google Chrome 安装路径；其他系统可通过 `CHROME_BIN` 指定 Chromium 可执行文件。

```sh
node tests/frontend-smoke.mjs http://127.0.0.1:8000/
```

测试使用单独的临时浏览器配置，涵盖录音播放、家长解锁、自绘下拉、创作和发布、听众隔离、刷新恢复及手机宽度布局。
