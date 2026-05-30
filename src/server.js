const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { URL } = require("node:url");

const { createConfig } = require("./config");
const { buildPaymentUrl, formatMoney, toCents, verifyParams } = require("./easypay");
const { OrderStore } = require("./orders");
const { ProductStore } = require("./products");
const { Sub2APIClient, extractUserId, normalizeUser, withSubscriptionInfo } = require("./sub2api");

const config = createConfig();
const sub2api = new Sub2APIClient(config.sub2api);
const orders = new OrderStore(config.dataDir);
const products = new ProductStore(config.dataDir);
const sessions = new Map();
const publicDir = path.join(process.cwd(), "public");
const sessionCookie = "easy_shop_session";
const sessionMaxAgeSeconds = 60 * 60 * 12;
const orderExpireMillis = config.orderExpireMinutes * 60 * 1000;

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function text(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function redirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

function publicError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  return Object.fromEntries(
    header
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf("=");
        return [decodeURIComponent(part.slice(0, index)), decodeURIComponent(part.slice(index + 1))];
      })
  );
}

function setCookie(res, name, value, options = {}) {
  const chunks = [`${encodeURIComponent(name)}=${encodeURIComponent(value)}`];
  chunks.push("Path=/");
  chunks.push("HttpOnly");
  chunks.push("SameSite=Lax");
  if (config.secureCookies) chunks.push("Secure");
  if (options.maxAge !== undefined) chunks.push(`Max-Age=${options.maxAge}`);
  res.setHeader("Set-Cookie", chunks.join("; "));
}

function clearCookie(res, name) {
  setCookie(res, name, "", { maxAge: 0 });
}

function createSession(res, authPayload, user) {
  const id = crypto.randomUUID();
  const expiresAt = Date.now() + sessionMaxAgeSeconds * 1000;
  sessions.set(id, {
    id,
    accessToken: authPayload.accessToken,
    refreshToken: authPayload.refreshToken || "",
    tokenType: authPayload.tokenType || "Bearer",
    user,
    expiresAt,
    createdAt: Date.now()
  });
  setCookie(res, sessionCookie, id, { maxAge: sessionMaxAgeSeconds });
  return sessions.get(id);
}

async function refreshSessionSubscriptions(session) {
  if (!session) return null;
  try {
    const subscriptions = await sub2api.activeSubscriptions(session.accessToken);
    session.user = withSubscriptionInfo(session.user, subscriptions);
  } catch (error) {
    try {
      const subscriptions = await sub2api.userSubscriptionsByAdmin(session.user.id);
      session.user = withSubscriptionInfo(session.user, subscriptions);
    } catch {
      session.user = {
        ...session.user,
        subscriptionLoaded: false,
        subscriptionError: error.message || "订阅到期时间获取失败"
      };
    }
  }
  return session.user;
}

function getSession(req) {
  const id = parseCookies(req)[sessionCookie];
  if (!id) return null;
  const session = sessions.get(id);
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    sessions.delete(id);
    return null;
  }
  return session;
}

function requireSession(req) {
  const session = getSession(req);
  if (!session) throw publicError("请先登录", 401);
  return session;
}

function requireAdmin(req) {
  if (!config.adminPassword) throw publicError("管理员口令未配置", 503);
  const password = String(req.headers["x-admin-password"] || "");
  if (!password || password !== config.adminPassword) throw publicError("管理员口令错误", 401);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function readJson(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw publicError("请求体不是有效 JSON", 400);
  }
}

async function readForm(req) {
  const raw = await readBody(req);
  return Object.fromEntries(new URLSearchParams(raw));
}

function orderExpiresAt(order) {
  if (order.expiresAt) return order.expiresAt;
  const createdAt = Date.parse(order.createdAt || "");
  if (!Number.isFinite(createdAt)) return new Date(Date.now() + orderExpireMillis).toISOString();
  return new Date(createdAt + orderExpireMillis).toISOString();
}

function isOrderExpired(order, now = Date.now()) {
  return order.status === "pending" && Date.parse(orderExpiresAt(order)) <= now;
}

async function ensureFreshOrder(order) {
  if (!order) return null;
  if (!isOrderExpired(order)) return order;
  return orders.update(order.id, {
    status: "expired",
    expiresAt: orderExpiresAt(order),
    expiredAt: new Date().toISOString()
  });
}

async function freshOrders(list) {
  const fresh = [];
  for (const order of list) {
    fresh.push(await ensureFreshOrder(order));
  }
  return fresh.filter(Boolean);
}

async function attachSubscriptionExpiresToOrders(list) {
  const completedMissing = list.filter((order) => order?.status === "completed" && !order.subscriptionExpiresAt);
  if (!completedMissing.length) return list;

  const cache = new Map();
  for (const order of completedMissing) {
    const userId = Number(order.sub2apiUserId);
    if (!userId || cache.has(userId)) continue;
    try {
      cache.set(userId, await sub2api.userSubscriptionsByAdmin(userId));
    } catch {
      cache.set(userId, []);
    }
  }

  return list.map((order) => {
    if (!order || order.status !== "completed" || order.subscriptionExpiresAt) return order;
    const groupId = Number(order.planSnapshot?.groupId);
    const latest = (cache.get(Number(order.sub2apiUserId)) || [])
      .filter((subscription) => {
        const active = !subscription.status || ["active", "valid", "enabled"].includes(subscription.status);
        return active && Number(subscription.groupId) === groupId && subscription.expiresAt;
      })
      .map((subscription) => subscription.expiresAt)
      .sort((a, b) => Date.parse(b) - Date.parse(a))[0];
    return latest ? { ...order, subscriptionExpiresAt: latest } : order;
  });
}

function cleanOrder(order) {
  if (!order) return null;
  const expiresAt = orderExpiresAt(order);
  const status = isOrderExpired(order) ? "expired" : order.status;
  const remainingSeconds =
    status === "pending" ? Math.max(0, Math.floor((Date.parse(expiresAt) - Date.now()) / 1000)) : 0;

  return {
    id: order.id,
    status,
    planId: order.planId,
    planName: order.planName,
    amount: order.amount,
    payType: order.payType,
    gatewayTradeNo: order.gatewayTradeNo || "",
    sub2apiUserEmail: order.sub2apiUserEmail || "",
    createdAt: order.createdAt,
    updatedAt: order.updatedAt || order.createdAt,
    expiresAt,
    subscriptionExpiresAt: order.subscriptionExpiresAt || "",
    remainingSeconds,
    paidAt: order.paidAt || "",
    deliveredAt: order.deliveredAt || "",
    failureReason: order.failureReason || ""
  };
}

function assertPayType(payType) {
  if (payType !== "alipay") {
    throw publicError("不支持的支付方式", 400);
  }
}

function createOrderId() {
  const time = new Date()
    .toISOString()
    .replace(/[-:.TZ]/g, "")
    .slice(0, 14);
  const suffix = crypto.randomBytes(4).toString("hex").toUpperCase();
  return `ES${time}${suffix}`;
}

async function ensureAuthPayloadHasUser(authPayload) {
  if (!authPayload.accessToken) {
    throw publicError("Sub2API 未返回访问令牌", 502);
  }

  let user = normalizeUser(authPayload.user);
  if (!user.id) {
    user = await sub2api.me(authPayload.accessToken);
  }
  if (!user.id) {
    throw publicError("无法识别 Sub2API 用户 ID", 502);
  }
  return user;
}

async function handleLogin(req, res) {
  const body = await readJson(req);
  const email = String(body.email || "").trim();
  const password = String(body.password || "");
  if (!email || !password) throw publicError("请输入邮箱和密码", 400);

  const authPayload = await sub2api.login({
    email,
    password,
    turnstileToken: body.turnstileToken || body.turnstile_token || ""
  });

  if (authPayload.requires2FA) {
    return json(res, 200, {
      requires2FA: true,
      tempToken: authPayload.tempToken,
      userEmailMasked: authPayload.userEmailMasked
    });
  }

  const user = await ensureAuthPayloadHasUser(authPayload);
  const session = createSession(res, authPayload, user);
  await refreshSessionSubscriptions(session);
  return json(res, 200, { user: session.user });
}

async function handleLogin2FA(req, res) {
  const body = await readJson(req);
  const tempToken = String(body.tempToken || body.temp_token || "").trim();
  const totpCode = String(body.totpCode || body.totp_code || "").trim();
  if (!tempToken || !totpCode) throw publicError("请输入二次验证码", 400);

  const authPayload = await sub2api.login2FA({ tempToken, totpCode });
  const user = await ensureAuthPayloadHasUser(authPayload);
  const session = createSession(res, authPayload, user);
  await refreshSessionSubscriptions(session);
  return json(res, 200, { user: session.user });
}

async function handleMe(req, res) {
  const session = getSession(req);
  if (!session) throw publicError("未登录", 401);
  await refreshSessionSubscriptions(session);
  return json(res, 200, { user: session.user });
}

async function handleLogout(req, res) {
  const id = parseCookies(req)[sessionCookie];
  if (id) sessions.delete(id);
  clearCookie(res, sessionCookie);
  return json(res, 200, { ok: true });
}

async function handleConfig(req, res) {
  const activeProducts = await products.list();
  return json(res, 200, {
    siteName: config.siteName,
    orderExpireMinutes: config.orderExpireMinutes,
    plans: activeProducts.map(publicProduct),
    payTypes: [
      { id: "alipay", name: "支付宝" }
    ]
  });
}

function publicProduct(product) {
  return {
    id: product.id,
    name: product.name,
    price: formatMoney(product.price),
    quotaLabel: product.quotaLabel,
    description: product.description,
    features: product.features,
    enabled: product.enabled !== false,
    sort: product.sort
  };
}

function adminProduct(product) {
  return {
    ...publicProduct(product),
    groupId: product.groupId,
    validityDays: product.validityDays,
    value: product.value,
    createdAt: product.createdAt,
    updatedAt: product.updatedAt
  };
}

async function handleProductList(req, res) {
  const activeProducts = await products.list();
  return json(res, 200, { products: activeProducts.map(publicProduct) });
}

async function handleAdminProductList(req, res) {
  requireAdmin(req);
  const list = await products.list({ includeDisabled: true });
  return json(res, 200, { products: list.map(adminProduct) });
}

async function handleAdminProductCreate(req, res) {
  requireAdmin(req);
  const product = await products.create(await readJson(req));
  return json(res, 201, { product: adminProduct(product) });
}

async function handleAdminProductUpdate(req, res, productId) {
  requireAdmin(req);
  const product = await products.update(productId, await readJson(req));
  if (!product) throw publicError("商品不存在", 404);
  return json(res, 200, { product: adminProduct(product) });
}

async function handleAdminProductDelete(req, res, productId) {
  requireAdmin(req);
  const removed = await products.remove(productId);
  if (!removed) throw publicError("商品不存在", 404);
  return json(res, 200, { ok: true });
}

async function handleAdminOrderList(req, res, url) {
  requireAdmin(req);
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") || 50)));
  const list = await attachSubscriptionExpiresToOrders(await freshOrders(await orders.list(limit)));
  return json(res, 200, { orders: list.map(cleanOrder) });
}

async function handleAdminDebugCompleteOrder(req, res, orderId) {
  requireAdmin(req);
  const body = await readJson(req);
  const order = await orders.get(orderId);
  if (!order) throw publicError("订单不存在", 404);
  if (order.status === "completed") {
    return json(res, 200, { order: cleanOrder(order), alreadyCompleted: true });
  }
  if (!["pending", "expired", "paid", "failed"].includes(order.status)) {
    throw publicError(`当前订单状态不能调试完成：${order.status}`, 400);
  }

  await processPaidOrder(order, {
    out_trade_no: order.id,
    trade_no: String(body.gatewayTradeNo || `DEBUG-${Date.now()}`),
    money: order.amount,
    trade_status: "TRADE_SUCCESS",
    debug: "true"
  });

  const updated = await orders.get(order.id);
  return json(res, 200, { order: cleanOrder(updated), debug: true });
}

async function handleCreateOrder(req, res) {
  const session = requireSession(req);
  const body = await readJson(req);
  const plan = await products.get(String(body.planId || ""));
  if (!plan) throw publicError("套餐不存在", 404);
  if (plan.enabled === false) throw publicError("套餐已下架", 400);
  const payType = String(body.payType || "alipay");
  assertPayType(payType);

  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + orderExpireMillis).toISOString();
  const order = {
    id: createOrderId(),
    status: "pending",
    planId: plan.id,
    planName: plan.name,
    planSnapshot: plan,
    amount: formatMoney(plan.price),
    payType,
    sub2apiUserId: session.user.id,
    sub2apiUserEmail: session.user.email,
    createdAt: now,
    updatedAt: now,
    expiresAt
  };

  await orders.create(order);
  const payUrl = buildPaymentUrl({
    easyPay: config.easyPay,
    order,
    plan,
    publicBaseUrl: config.publicBaseUrl,
    siteName: config.siteName,
    payType
  });

  return json(res, 200, { order: cleanOrder(order), payUrl });
}

async function handleOrderDetail(req, res, orderId) {
  const session = requireSession(req);
  const [order] = await attachSubscriptionExpiresToOrders([await ensureFreshOrder(await orders.get(orderId))]);
  if (!order || Number(order.sub2apiUserId) !== Number(session.user.id)) {
    throw publicError("订单不存在", 404);
  }
  return json(res, 200, { order: cleanOrder(order) });
}

async function handlePayOrder(req, res, orderId) {
  const session = requireSession(req);
  const body = await readJson(req);
  const order = await ensureFreshOrder(await orders.get(orderId));
  if (!order || Number(order.sub2apiUserId) !== Number(session.user.id)) {
    throw publicError("订单不存在", 404);
  }
  if (order.status !== "pending") {
    throw publicError("当前订单不是待支付状态", 400);
  }

  const plan = order.planSnapshot || (await products.get(order.planId));
  if (!plan) throw publicError("套餐不存在", 404);

  let payType = order.payType || "alipay";
  if (body.payType) {
    payType = String(body.payType);
    assertPayType(payType);
  }

  const updatedOrder =
    payType === order.payType
      ? order
      : await orders.update(order.id, {
          payType
        });

  const payUrl = buildPaymentUrl({
    easyPay: config.easyPay,
    order: updatedOrder,
    plan,
    publicBaseUrl: config.publicBaseUrl,
    siteName: config.siteName,
    payType
  });

  return json(res, 200, { order: cleanOrder(updatedOrder), payUrl });
}

async function handleOrderList(req, res) {
  const session = requireSession(req);
  const list = await attachSubscriptionExpiresToOrders(await freshOrders(await orders.listByUser(session.user.id)));
  return json(res, 200, { orders: list.map(cleanOrder) });
}

async function deliverSubscription(order) {
  const plan = order.planSnapshot || (await products.get(order.planId));
  if (!plan) throw new Error(`plan not found: ${order.planId}`);
  if (!extractUserId({ id: order.sub2apiUserId })) {
    throw new Error("order missing Sub2API user id");
  }

  const latestOrder = (await orders.get(order.id)) || order;
  const deliveryAttempt = Number(latestOrder.deliveryAttempts || 0) + 1;
  await orders.update(order.id, {
    deliveryAttempts: deliveryAttempt,
    lastDeliveryAttemptAt: new Date().toISOString()
  });

  const response = await sub2api.createAndRedeemSubscription({
    order,
    plan,
    userId: order.sub2apiUserId,
    idempotencyKey: `easy-shop-${order.id}-deliver-${deliveryAttempt}`
  });

  await orders.update(order.id, {
    status: "completed",
    deliveredAt: new Date().toISOString(),
    sub2apiResponse: response,
    subscriptionExpiresAt: await resolveDeliveredSubscriptionExpiresAt(order, plan),
    failureReason: ""
  });
}

async function resolveDeliveredSubscriptionExpiresAt(order, plan) {
  try {
    const subscriptions = await sub2api.userSubscriptionsByAdmin(order.sub2apiUserId);
    const matching = subscriptions.filter((subscription) => {
      const sameGroup = Number(subscription.groupId) === Number(plan.groupId);
      const active = !subscription.status || ["active", "valid", "enabled"].includes(subscription.status);
      return sameGroup && active && subscription.expiresAt;
    });
    const latest = matching
      .map((subscription) => subscription.expiresAt)
      .sort((a, b) => Date.parse(b) - Date.parse(a))[0];
    return latest || "";
  } catch {
    return "";
  }
}

async function processPaidOrder(order, notifyParams) {
  if (order.status === "completed") return;
  if (toCents(order.amount) !== toCents(notifyParams.money)) {
    throw new Error(`payment amount mismatch: expected ${order.amount}, got ${notifyParams.money}`);
  }

  const paidOrder = await orders.update(order.id, {
    status: "paid",
    gatewayTradeNo: notifyParams.trade_no || "",
    paidAt: new Date().toISOString(),
    notifyPayload: notifyParams
  });

  try {
    await deliverSubscription(paidOrder);
  } catch (error) {
    await orders.update(order.id, {
      status: "failed",
      failureReason: error.message
    });
    throw error;
  }
}

async function handleEasyPayNotify(req, res, url) {
  const params =
    req.method === "GET"
      ? Object.fromEntries(url.searchParams)
      : await readForm(req);

  if (!verifyParams(params, config.easyPay.key)) {
    return text(res, 400, "fail");
  }

  const status = String(params.trade_status || "").toUpperCase();
  if (status && status !== "TRADE_SUCCESS") {
    return text(res, 200, "success");
  }

  const orderId = String(params.out_trade_no || "").trim();
  const order = await orders.get(orderId);
  if (!order) return text(res, 404, "fail");

  try {
    await processPaidOrder(order, params);
  } catch (error) {
    console.error(`[notify] order ${orderId} delivery failed:`, error);
    return text(res, 500, "fail");
  }

  return text(res, 200, "success");
}

async function handleEasyPayReturn(req, res, url) {
  const orderId = url.searchParams.get("order") || url.searchParams.get("out_trade_no") || "";
  return redirect(res, `/?order=${encodeURIComponent(orderId)}`);
}

async function handleRetryOrder(req, res, orderId) {
  const session = requireSession(req);
  const order = await ensureFreshOrder(await orders.get(orderId));
  if (!order || Number(order.sub2apiUserId) !== Number(session.user.id)) {
    throw publicError("订单不存在", 404);
  }
  if (!["paid", "failed"].includes(order.status)) {
    throw publicError("当前订单状态不能重试发放", 400);
  }

  await deliverSubscription(order);
  const updated = await orders.get(orderId);
  return json(res, 200, { order: cleanOrder(updated) });
}

async function serveStatic(req, res, url) {
  const pathname =
    url.pathname === "/"
      ? "/index.html"
      : url.pathname === "/admin"
        ? "/admin.html"
        : decodeURIComponent(url.pathname);
  const filePath = path.normalize(path.join(publicDir, pathname));
  if (!filePath.startsWith(publicDir)) throw publicError("Not found", 404);

  const ext = path.extname(filePath).toLowerCase();
  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml"
  };

  try {
    const content = await fs.readFile(filePath);
    res.writeHead(200, {
      "Content-Type": types[ext] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    res.end(content);
  } catch {
    throw publicError("Not found", 404);
  }
}

async function route(req, res) {
  const url = new URL(req.url, config.publicBaseUrl);
  const method = req.method || "GET";

  if (method === "GET" && url.pathname === "/healthz") return json(res, 200, { ok: true });
  if (method === "GET" && url.pathname === "/api/config") return handleConfig(req, res);
  if (method === "GET" && url.pathname === "/api/products") return handleProductList(req, res);
  if (method === "GET" && url.pathname === "/api/admin/products") return handleAdminProductList(req, res);
  if (method === "POST" && url.pathname === "/api/admin/products") return handleAdminProductCreate(req, res);
  if (method === "GET" && url.pathname === "/api/admin/orders") return handleAdminOrderList(req, res, url);
  if (method === "POST" && url.pathname === "/api/login") return handleLogin(req, res);
  if (method === "POST" && url.pathname === "/api/login/2fa") return handleLogin2FA(req, res);
  if (method === "GET" && url.pathname === "/api/me") return handleMe(req, res);
  if (method === "POST" && url.pathname === "/api/logout") return handleLogout(req, res);
  if (method === "GET" && url.pathname === "/api/orders") return handleOrderList(req, res);
  if (method === "POST" && url.pathname === "/api/orders") return handleCreateOrder(req, res);

  const orderMatch = url.pathname.match(/^\/api\/orders\/([^/]+)$/);
  if (method === "GET" && orderMatch) return handleOrderDetail(req, res, orderMatch[1]);

  const productMatch = url.pathname.match(/^\/api\/admin\/products\/([^/]+)$/);
  if (method === "PUT" && productMatch) return handleAdminProductUpdate(req, res, productMatch[1]);
  if (method === "DELETE" && productMatch) return handleAdminProductDelete(req, res, productMatch[1]);

  const debugCompleteMatch = url.pathname.match(/^\/api\/admin\/orders\/([^/]+)\/debug-complete$/);
  if (method === "POST" && debugCompleteMatch) return handleAdminDebugCompleteOrder(req, res, debugCompleteMatch[1]);

  const payMatch = url.pathname.match(/^\/api\/orders\/([^/]+)\/pay$/);
  if (method === "POST" && payMatch) return handlePayOrder(req, res, payMatch[1]);

  const retryMatch = url.pathname.match(/^\/api\/orders\/([^/]+)\/retry$/);
  if (method === "POST" && retryMatch) return handleRetryOrder(req, res, retryMatch[1]);

  if ((method === "GET" || method === "POST") && url.pathname === "/payment/notify/easypay") {
    return handleEasyPayNotify(req, res, url);
  }
  if (method === "GET" && url.pathname === "/payment/return/easypay") {
    return handleEasyPayReturn(req, res, url);
  }

  if (method === "GET" || method === "HEAD") return serveStatic(req, res, url);
  throw publicError("Method not allowed", 405);
}

async function main() {
  await orders.init();
  await products.init(config.plans);

  if (config.sessionSecret === "dev-only-change-me") {
    console.warn("[security] SESSION_SECRET is using the development default");
  }
  if (!config.adminPassword) {
    console.warn("[security] ADMIN_PASSWORD is not configured; product management APIs are disabled");
  }

  const server = http.createServer((req, res) => {
    route(req, res).catch((error) => {
      const status = error.status || 500;
      if (status >= 500) console.error(error);
      json(res, status, { error: error.message || "Internal server error" });
    });
  });

  server.listen(config.port, () => {
    console.log(`${config.siteName} listening on http://localhost:${config.port}`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
