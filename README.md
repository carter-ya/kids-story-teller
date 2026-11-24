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

在被 Git 忽略的 `.dev.vars` 中设置 `RESEND_API_KEY` 和 `RESEND_FROM`。发件地址须使用你在 Resend 验证过的域名。打开 Wrangler 显示的地址，点「家长登录」，输入邮箱和邮件中的六位验证码。首次验证后自动创建家庭。在「我的家庭 → 模型与声音」连接 OpenAI 或 DeepSeek，选择写作模型或使用配音预设，先试听再生成全篇。可以直接导入自己的稿件。把设备交给孩子前，点「交给孩子」。

Workers 提供同源 API，D1 保存家庭、会话、任务和加密后的凭据，私有 R2 保存书架及 WAV 录音，Queues 执行写作和配音。每个家庭最多 20 人、100 篇故事、100 MB。单次书架 JSON 请求限 8 MB，单篇配音最多 4000 字、32 MB。后台会回收未引用的录音，临时试听至少保留一天。不同设备同时编辑时页面提示版本冲突，可先导出稿件再重新加载。

## 部署到 Cloudflare

在目标账户创建 D1 数据库 `story-families`、R2 存储桶 `story-family-files` 和队列 `story-narration`，在自己的部署配置中填写 D1 的 `database_id`。使用 `npx wrangler secret put VAULT_KEY` 设置单独生成的 64 位十六进制密钥。用同一部署配置分别执行 `npx wrangler secret put RESEND_API_KEY` 和 `npx wrangler secret put RESEND_FROM`，按提示填写发送密钥和已验证域名的发件地址。运行 `npx wrangler d1 migrations apply DB --remote`（包括 `0006_email_login.sql`）后执行 `npx wrangler deploy --keep-vars`，保留控制台中配置的发件地址。以 HTTPS 访问站点，保持 R2 私有。仓库配置不含真实邮箱、账号标识或服务商密钥。

平台开销取决于账号总用量，100 MB 是单个家庭的应用额度。Queues 和 R2 各有免费用量，写作和配音由家长的服务商账户独立计费。[Queues 价格](https://developers.cloudflare.com/queues/platform/pricing/) · [R2 价格](https://developers.cloudflare.com/r2/pricing/)

## 验证

```sh
npm test
npm run test:worker
node tests/frontend-smoke.mjs --cloud
```

云端浏览器测试启动临时 Worker、D1 与模拟收件箱，创建一个独立测试家庭，验证引导、草稿持久化、孩子权限及家长重新登录。协议测试模拟供应商的成功和中断响应，真实听感仍需使用自己的 Key 试听。

## 单独运行静态前端体验

在项目根目录使用 Python 3 启动静态站点。应用无需安装包或构建。

```sh
python3 -m http.server 8000 --bind 127.0.0.1 --directory web
```

在浏览器打开 `http://127.0.0.1:8000/`。访客可在首页直接试听，点「打开本地预览」后按五个实际操作完成首次引导。邮箱登录通过 Workers 运行。同一浏览器和站点地址下的数据存于 IndexedDB，切换听众可检查各自的书架、收藏与进度。

## 静态体验范围

- 书架有三篇带普通话录音的原创绘本，支持播放、拖动、续听、收藏和定时停止。
- 进入家长区后可写作、导入文本、改稿、管理版本、选择声音、发布给指定孩子，也可撤回、归档、导出和删除作品。
- 文字生成使用本地示例逻辑。自创故事使用浏览器可用的中文系统语音朗读，语音可用性取决于设备。内置绘本使用独立音频文件。
- 服务商配置支持预演地址、模型和密钥输入。密钥不会发送或写入存储。本地体验的家庭成员和额度预留均用于界面评审。云端家庭版使用上面的 Workers 启动方式。

## 目录与验证

`web/index.html` 为入口。书架与本地状态在 `app.js`，播放器、创作台、家庭设置分别在 `player.js`、`studio.js`、`family.js`。全站下拉使用 `picker.js`。示例故事正文及录音索引在 `web/samples.js`，录音与绘本封面在 `web/assets/`。三篇内置故事使用本机增强普通话音色重新制作，保留对白与段落停顿。使用已安装相应音色的 macOS、Xcode Command Line Tools 和 Python 3.12+，可运行 `python3 tools/render_samples.py` 重新生成并验证录音。

使用 Node.js 22.4+（内置 WebSocket）和 Chrome，先启动上面的本地服务，再从根目录运行浏览器回归测试。macOS 默认使用标准 Google Chrome 安装路径；其他系统可通过 `CHROME_BIN` 指定 Chromium 可执行文件。

```sh
node tests/frontend-smoke.mjs http://127.0.0.1:8000/
```

测试使用单独的临时浏览器配置，涵盖录音播放、家长解锁、自绘下拉、创作和发布、听众隔离、刷新恢复及手机宽度布局。

## 邮箱登录与家庭邀请

家长输入邮箱后查收六位验证码，10 分钟内有效。再次发送需间隔 60 秒，连续输错五次后需重新获取。每个邮箱关联一个家庭；孩子在平板上使用听众档案，从儿童模式回到家长区需验证本家庭的家长邮箱。

已有书架的家长首次应点「找回旧书架」，同时提供原凭据并验证邮箱。已登录的旧设备也可在「我的家庭」选择「为旧书架绑定邮箱」。绑定保留原家庭、作品和权限，旧凭据随即失效。管理员在「邀请成人」生成仅可使用一次的链接，私下发给另一位照护者。对方打开链接后验证自己的邮箱，链接一天后到期。撤销访问会注销其设备并清除其个人服务配置。

Resend 的发送密钥仅供 Worker 使用。默认每 24 小时最多尝试发送 100 封验证码邮件；可用 `EMAIL_DAILY_LIMIT` 配置全站上限。测试模式的 `resend.dev` 发件地址仅能用于账户自己的收件箱。详见[发件域名设置](https://resend.com/docs/knowledge-base/403-error-resend-dev-domain)。

在「模型与声音」中为写作和朗读分别建立配置。密钥默认仅持有人可用，可勾选共享给其他成人。高级选项支持兼容协议的 HTTPS 根地址、每日调用次数、单次及每月输入字数。月和日的边界按 UTC 计算，重试从剩余片段计费计数。官方地址直接可用。公网部署设置 `PUBLIC_PROVIDER_GATEWAYS=1` 后，家长可以直接填入自选公网 HTTPS 网关；Worker 在使用前核验域名与公网 DNS 记录。私网预览可通过 `PROVIDER_ORIGINS` 指定受信网关来源（逗号分隔）。更换地址时必须重新输入 Key。年龄段与希望避开的内容随写作请求发送，孩子昵称不自动发送。

## 家庭内容与设备验收

在故事工作台展开「封面、系列与版本」上传图片，浏览器缩小并重新编码为 WebP。已发布的孩子书架沿用家长确认时的封面。成品朗读可以直接下载 WAV。配音失败后可点「继续生成剩余片段」，已完整返回并保存的片段会复用。

管理员可在家庭设置下载 TAR 归档，其中有家庭资料、作品、录音、封面和用量记录；邮箱登录信息与可解密的服务密钥不随归档导出。删除整个家庭需输入确认文字，会立即撤销访问，后台清理存储对象。首次 API 访问启动维护队列，以后每十分钟由延迟消息调度；D1 记录调度状态，后续访问也能唤醒中断的维护任务。此模式不占用账户 Cron 名额。

真机验收时，家长可先发布一篇录音给指定孩子，在手机收听 15 秒并暂停，锁屏后通过系统播放控件继续。然后用同一家庭在平板切到同一孩子，重新打开书架，核对录音和续播位置。撤回发布后，再次打开录音应被拒绝。
