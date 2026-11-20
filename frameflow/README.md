# FrameFlow · AI 视频工作台

左侧管理、复制镜头或按行批量导入，中间编辑单个镜头的提示词和参数，右侧多选素材后一次添加到参考图。可单条生成或把已填写的镜头一起入队。输入 `@` 可选用素材并插入引用。可为每部剧新建素材文件夹，批量上传或从资产库批量移动已有素材。可预览和下载生成结果。

## 百炼接入

- 模型 `wan3.0-video`，固定 `480P`；可选画幅和 2–30 秒时长。通过百炼业务空间的专属域名调用异步生成接口。
- 准备已开通万相 3.0 的阿里云百炼 API Key、业务空间 ID 和对应地域。在线版每位受邀用户登录后点右上角「配置万相」填写自己的配置，Key 经服务端加密保存，不在页面回显。线上没有共享或备用的百炼 Key。
- 每人默认最多 3 个正在提交或生成的任务；站点可设 `FRAMEFLOW_CONCURRENCY=1` 或 `2`。批量最多 20 条，单条最多 10 张参考图，工作台内联上传限制为单张 4 MB、每条分镜合计 12 MB。调用消耗 API Key 所属的阿里云账号额度。
- 任务记录近 200 条。移除素材只从列表隐藏，历史任务仍可以读取相应的图。已完成视频保存在本地磁盘或托管对象存储中。

## 本地运行

需要 Node.js 22.13+，无需安装依赖。在本目录运行 `node local.mjs`，打开 `http://127.0.0.1:4177`。未接通也可以先管理素材和编辑分镜。

在本地 `.env` 设置 `DASHSCOPE_API_KEY`、`DASHSCOPE_WORKSPACE_ID` 和 `DASHSCOPE_REGION` 后重新运行。只要此进程保持运行，关闭浏览器后也会继续处理队列。本地状态和文件保存在 `.frameflow/`，分镜草稿保存在当前浏览器；这些数据不会自动上传到在线版。

## Cloudflare 免费额度部署

本方案不依赖 ChatGPT 登录。部署使用 Workers Free、D1 和私有 R2。需要在自己的 Cloudflare 账号里启用 `workers.dev`，并在控制台自行确认 R2 开通与计费条款；R2 超出免费存储或操作额度可能收费。不要上传本地 `.env` 或 `.frameflow/`，也不要设置线上共享百炼 Key。

1. 安装 Node.js 和 pnpm，运行 `pnpm dlx wrangler@4.165.0 login`，在 Cloudflare 官网完成授权。
2. 运行 `pnpm dlx wrangler@4.165.0 d1 create frameflow-studio` 和 `pnpm dlx wrangler@4.165.0 r2 bucket create frameflow-studio`。R2 桶保持私有，不要开启公共访问。
3. 复制 `wrangler.example.jsonc` 到 `wrangler.local.jsonc`，将占位符替换为上一步返回的 D1 数据库 ID。在项目目录运行 `pnpm dlx wrangler@4.165.0 d1 migrations apply DB --remote --config wrangler.local.jsonc`。
4. 分别生成两个独立的 64 位十六进制随机值，作为 Worker Secret `FRAMEFLOW_CREDENTIAL_SECRET` 和 `FRAMEFLOW_MEDIA_SECRET`。用 `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"` 私下生成，用 `pnpm dlx wrangler@4.165.0 secret put <名称> --config wrangler.local.jsonc` 的交互提示输入。不要写入源码、聊天或本地配置文件；更换凭据加密 Secret 后，用户需要重填原有百炼 Key。
5. 运行 `node invite.mjs create <账号>`，为自己和每位朋友各建一个账号；只把对应访问码私发给本人。可用 `node invite.mjs rotate <账号>` 重置访问码并退出所有旧会话，或用 `node invite.mjs disable <账号>` 停用。访问码不可找回，务必单独保管。
6. 运行 `pnpm dlx wrangler@4.165.0 deploy --config wrangler.local.jsonc`。使用命令输出的 HTTPS 地址登录，并测试真实网络上的访问、素材上传及视频下载。

素材和视频保存在私有 R2。提交生成时，百炼收到 15 分钟内有效、仅能读取指定参考图的链接。用户仅可通过自己的账号访问分镜、素材、任务和配置。关闭网页后，已提交给百炼的任务仍在百炼侧运行；其余排队任务及结果同步在重新打开网页后继续。先从少量视频开始试用，并定期查看 R2 用量；中国大陆直连稳定性不保证。

## OpenAI Sites 托管（可选）

`node build.mjs` 产出 Sites Worker，使用 D1 和 R2。设置 Sites 私密变量 `FRAMEFLOW_CREDENTIAL_SECRET`（32 随机字节的 64 位十六进制表示）。这个变量不是百炼 Key，不能放进源代码；更换后原有密钥无法解密，须重填。不要上传本地 `.env` 或 `.frameflow/`，也不要设置线上共享百炼 Key。

在 Sites 中添加朋友为受邀访客，朋友使用被邀请的账号登录。工作台用站点提供的登录 ID 隔离分镜草稿、素材、文件夹、任务、视频和百炼配置。在线版由打开的工作台触发每位用户自己的队列推进和结果保存：关闭页面后，已提交给百炼的任务仍在百炼侧运行，工作台队列在重新打开后继续。
