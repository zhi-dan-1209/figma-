# Monkey View 正式部署版

Monkey View 把 Figma 中锁定的手机画板实时同步到安卓浏览器。编辑时先发送轻量 JPEG，停止修改约 1 秒后自动补发 3× 高清画面。

## 项目组成

- `figma-plugin/`：Figma 开发插件。
- `server.mjs`：会话、图片上传和 WebSocket 通知服务。
- `public/`：安卓手机预览页面。
- `Dockerfile`：预览服务容器。
- `docker-compose.yml`：Node 服务和 Caddy HTTPS 入口。
- `deploy/Caddyfile`：固定域名、自动 HTTPS 和 WebSocket 反向代理。

## 推荐生产环境

- 一台持续在线的 Linux 云服务器，建议选择中国大陆合规节点或香港节点。
- 一个固定域名，例如 `preview.example.com`。
- 域名的 A/AAAA 记录指向服务器。
- 服务器允许公网访问 TCP 80 和 443。
- 已安装 Docker Engine 和 Docker Compose。

正式环境应只运行一个应用实例。当前会话和图片只保存在内存中；如果需要多实例部署，应再接入 Redis、对象存储和会话粘滞。

## Docker + 固定域名部署

1. 将整个项目上传到服务器。
2. 创建生产环境配置：

   ```bash
   cp .env.example .env
   ```

3. 编辑 `.env`，至少填写真实域名：

   ```dotenv
   DOMAIN=preview.example.com
   SESSION_TTL_MINUTES=120
   MAX_SESSIONS=1000
   MAX_IMAGE_MB=12
   ```

4. 启动：

   ```bash
   docker compose up -d --build
   ```

5. 检查：

   ```bash
   curl https://preview.example.com/api/health
   ```

   正常结果包含：

   ```json
   {"ok":true,"service":"monkey-view"}
   ```

Caddy 会自动申请并续期 HTTPS 证书，也会自动代理 WebSocket。

## 部署到现有 Node.js 平台

如果平台原生提供 HTTPS，可只运行 Node 服务：

```bash
npm ci --omit=dev
npm start
```

环境变量：

```dotenv
PORT=3000
PUBLIC_BASE_URL=https://preview.example.com
SESSION_TTL_MINUTES=120
MAX_SESSIONS=1000
MAX_IMAGE_MB=12
```

平台必须支持 WebSocket，并保持单实例持续运行。不要选择会频繁休眠或随请求自动扩容到多个无状态实例的配置。

## 安装 Figma 插件

1. Figma Desktop → **Plugins → Development → Import plugin from manifest…**。
2. 选择 `figma-plugin/manifest.json`。
3. 选中一个顶层手机 Frame，运行 **Monkey View**。
4. 输入固定服务地址，例如 `https://preview.example.com`。
5. 点击“创建手机预览”，安卓 Chrome 扫描二维码。

服务地址会保存在 Figma 本地。开始预览后画板会被锁定，点击其他画板不会切换；点击“停止预览并重新选择画板”后可以重新锁定。

## 正式发布前收紧 Figma 网络权限

开发版 `manifest.json` 使用 `allowedDomains: ["*"]`，方便填写不同服务器。确定正式域名后，建议改为：

```json
"networkAccess": {
  "allowedDomains": [
    "https://preview.example.com",
    "wss://preview.example.com"
  ]
}
```

然后重新导入或发布插件。

## 数据与安全

- 发布端使用随机令牌认证，手机链接不能上传或覆盖图片。
- 会话自动过期，也可以在插件中主动停止。
- 图片仅存于服务进程内存，不写入磁盘。
- 服务重启会清空所有会话和图片。
- 单张图片默认最多 12MB。
- 单个来源默认 10 分钟最多创建 30 个会话。
- 使用公网服务前，应确认公司设计数据安全要求。

## 更新部署

```bash
docker compose up -d --build
docker image prune -f
```

更新会重启服务，因此已有二维码会话会失效，重新创建即可。
