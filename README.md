# Easy Shop

一个轻量发卡网站：用户使用 Sub2API 账号登录，选择套餐后跳转易支付，支付回调验签成功后通过 Sub2API 管理端接口给对应用户发放订阅。

## 能实现的闭环

- Sub2API 邮箱账号登录，兼容 TOTP 二次验证。
- 易支付 `submit.php` 下单跳转。
- 易支付异步通知 MD5 验签、金额校验、订单幂等处理。
- 待支付订单默认 15 分钟过期，可配置倒计时和过期关闭。
- 支付成功后调用 Sub2API `POST /api/v1/admin/redeem-codes/create-and-redeem` 发放订阅。
- 登录后读取 Sub2API 当前账号活跃订阅，并在账号卡片显示真实订阅到期时间。
- 用户页包含购买、订单中心、账号绑定；后台独立在 `/admin`。
- 页面内增删改商品，商品数据保存在 `data/products.json`。
- 本地 `data/orders.json` 保存订单状态，适合先跑 MVP。

## 快速启动

1. 复制 `.env.example` 为 `.env`，填入你的 Sub2API 地址、Admin API Key、易支付 PID/KEY、管理员口令。
2. 运行：

```bash
npm start
```

3. 打开 `http://localhost:3000`。

## Docker 部署

1. 准备配置：

```bash
cp .env.example .env
```

编辑 `.env`，至少填写：

```text
PUBLIC_BASE_URL=https://你的域名
SESSION_SECRET=换成一串长随机字符
ADMIN_PASSWORD=后台管理口令
SUB2API_BASE_URL=https://你的-sub2api-域名
SUB2API_ADMIN_API_KEY=你的-sub2api-admin-api-key
EASYPAY_API_BASE=https://你的易支付域名
EASYPAY_PID=你的商户ID
EASYPAY_KEY=你的商户密钥
```

`PUBLIC_BASE_URL` 必须是易支付服务器能访问到的公网地址，不能是 `localhost`。否则易支付会把通知发到它自己机器的 localhost，本站收不到回调，页面会显示“未通知成功”。

2. 构建并启动：

```bash
docker compose up -d --build
```

3. 查看日志：

```bash
docker compose logs -f easy-shop
```

4. 停止服务：

```bash
docker compose down
```

订单和商品数据保存在 Docker volume `easy-shop-data` 里，对应容器内 `/app/data`。不要把 `.env`、`data/*.json` 提交到公开仓库。

容器内固定监听 `3000`，需要改宿主机端口时改 `.env` 的 `HOST_PORT`，例如 `HOST_PORT=8088`。

如果 Sub2API 也跑在同一个 `docker-compose.yml` 网络里，`SUB2API_BASE_URL` 可以写服务名，例如：

```text
SUB2API_BASE_URL=http://sub2api:8080
```

如果 Sub2API 跑在宿主机而 Easy Shop 跑在 Docker 容器里，不能写 `http://localhost:8080`，应写：

```text
SUB2API_BASE_URL=http://host.docker.internal:8080
```

如果 Sub2API 是公网服务，直接写公网域名，例如：

```text
SUB2API_BASE_URL=https://sub2api.example.com
```

生产环境请把 `PUBLIC_BASE_URL` 改成 HTTPS 域名，并把易支付后台的异步通知地址设置为：

```text
https://你的域名/payment/notify/easypay
```

同步跳转地址：

```text
https://你的域名/payment/return/easypay
```

## Sub2API 配置要点

- 在 Sub2API 后台生成 Admin API Key，填到 `SUB2API_ADMIN_API_KEY`。
- 商品里的 `groupId` 必须是 Sub2API 已存在的订阅分组 ID。
- 当前订阅到期时间默认从 `GET /api/v1/subscriptions/active` 读取；如果你的 Sub2API 路径不同，改 `.env` 里的 `SUB2API_ACTIVE_SUBSCRIPTIONS_PATH`。
- 支付成功后本站会发送：

```json
{
  "code": "ES-订单号",
  "type": "subscription",
  "value": 30,
  "user_id": 123,
  "group_id": 1,
  "validity_days": 30,
  "notes": "Easy Shop order ES..."
}
```

## 说明

当前版本故意不引入数据库和框架，核心链路更容易部署和排错。订单量上来后，可以把 `src/orders.js` 换成 SQLite/MySQL，并加一个管理员订单后台。

## 商品管理

首次启动时，系统会用 `.env` 里的 `PLANS_JSON` 初始化 `data/products.json`。之后商品以页面管理为准：

1. 打开 `/admin`。
2. 输入 `.env` 中的 `ADMIN_PASSWORD`。如果没有配置，商品管理接口会返回“管理员口令未配置”。
3. 点击“载入商品”。
4. 在页面里新增、编辑、上架、下架或删除商品。

删除商品不会影响已经创建的订单，因为订单会保存商品快照。

## 订单超时

默认待支付订单有效期是 15 分钟。可在 `.env` 中调整：

```text
ORDER_EXPIRE_MINUTES=15
```

订单过期后前端会显示“已关闭”，继续支付会被拒绝。若易支付已经成功扣款并发送异步通知，系统仍会按支付成功处理并发放订阅，避免用户付款后丢单。

## 支付成功但未发放

易支付回调验签和金额校验通过后，本站会立即返回 `success`，避免支付平台反复提示通知失败。若 Sub2API 暂时不可达或发放失败，订单会变成“发放失败”，后台 `/admin` 最近订单里点击“模拟成功”或用户订单里“重试发放”即可重新走真实发放流程。

常见部署问题：

- 易支付订单里的通知地址是 `http://localhost:3000/...`：把 `.env` 的 `PUBLIC_BASE_URL` 改成公网 HTTPS 域名，重启容器后重新下单。
- 日志出现 `Sub2API request timed out` 或 `fetch failed`：容器访问不到 `SUB2API_BASE_URL`，按上面的 Docker 网络说明改地址。
- 反代后公网打不开 `/payment/notify/easypay`：检查 Nginx/Caddy 是否把该路径转发到 Easy Shop 容器。
