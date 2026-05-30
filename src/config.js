const fs = require("node:fs");
const path = require("node:path");

function loadDotEnv() {
  const envPath = path.join(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) return;

  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  let currentKey = null;
  let currentValue = [];

  const flush = () => {
    if (!currentKey) return;
    if (process.env[currentKey] === undefined) {
      process.env[currentKey] = currentValue.join("\n").trim();
    }
    currentKey = null;
    currentValue = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line || line.trimStart().startsWith("#")) continue;

    if (currentKey && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(line)) {
      currentValue.push(line);
      continue;
    }

    flush();
    const index = line.indexOf("=");
    if (index === -1) continue;
    currentKey = line.slice(0, index).trim();
    currentValue = [line.slice(index + 1).trim()];
  }

  flush();
}

function stripTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function parsePlans() {
  const fallback = [
    {
      id: "basic-month",
      name: "基础月卡",
      price: "19.90",
      groupId: 1,
      validityDays: 30,
      value: 30,
      quotaLabel: "30 天",
      description: "轻量开发与个人体验",
      features: ["订阅分组 30 天", "支付成功自动开通", "可在 Sub2API 后台续期"]
    },
    {
      id: "pro-month",
      name: "专业月卡",
      price: "39.90",
      groupId: 2,
      validityDays: 30,
      value: 30,
      quotaLabel: "30 天",
      description: "高频使用与多端工具",
      features: ["专业分组 30 天", "支付成功自动开通", "适合 Claude Code / Codex"]
    }
  ];

  const raw = process.env.PLANS_JSON;
  if (!raw) return fallback;

  try {
    const plans = JSON.parse(raw);
    if (!Array.isArray(plans) || plans.length === 0) {
      throw new Error("PLANS_JSON must be a non-empty array");
    }
    return plans.map((plan) => validatePlan(plan));
  } catch (error) {
    console.warn(`[config] PLANS_JSON invalid, using fallback plans: ${error.message}`);
    return fallback;
  }
}

function validatePlan(plan) {
  const price = String(plan.price || "").trim();
  if (!plan.id || !plan.name || !price || !plan.groupId || !plan.validityDays) {
    throw new Error("plan requires id, name, price, groupId, validityDays");
  }
  return {
    id: String(plan.id),
    name: String(plan.name),
    price,
    groupId: Number(plan.groupId),
    validityDays: Number(plan.validityDays),
    value: Number(plan.value || plan.validityDays),
    quotaLabel: String(plan.quotaLabel || `${plan.validityDays} 天`),
    description: String(plan.description || ""),
    features: Array.isArray(plan.features) ? plan.features.map(String) : []
  };
}

function createConfig() {
  loadDotEnv();

  const port = Number(process.env.PORT || 3000);
  const publicBaseUrl = stripTrailingSlash(process.env.PUBLIC_BASE_URL || `http://localhost:${port}`);
  const easyPayBase = stripTrailingSlash(process.env.EASYPAY_API_BASE || "");
  const orderExpireMinutes = Math.max(1, Number(process.env.ORDER_EXPIRE_MINUTES || 15));

  return {
    port,
    siteName: process.env.SITE_NAME || "Easy Shop",
    publicBaseUrl,
    secureCookies: publicBaseUrl.startsWith("https://"),
    sessionSecret: process.env.SESSION_SECRET || "dev-only-change-me",
    adminPassword: process.env.ADMIN_PASSWORD || "",
    orderExpireMinutes,
    dataDir: path.join(process.cwd(), "data"),
    sub2api: {
      baseUrl: stripTrailingSlash(process.env.SUB2API_BASE_URL || "http://localhost:8080"),
      adminApiKey: process.env.SUB2API_ADMIN_API_KEY || "",
      endpoints: {
        login: process.env.SUB2API_LOGIN_PATH || "/api/v1/auth/login",
        login2FA: process.env.SUB2API_LOGIN_2FA_PATH || "/api/v1/auth/login/2fa",
        me: process.env.SUB2API_ME_PATH || "/api/v1/auth/me",
        activeSubscriptions:
          process.env.SUB2API_ACTIVE_SUBSCRIPTIONS_PATH ||
          "/api/v1/subscriptions/active",
        adminUserSubscriptions:
          process.env.SUB2API_ADMIN_USER_SUBSCRIPTIONS_PATH ||
          "/api/v1/admin/users/{userId}/subscriptions",
        createAndRedeem:
          process.env.SUB2API_CREATE_AND_REDEEM_PATH ||
          "/api/v1/admin/redeem-codes/create-and-redeem"
      }
    },
    easyPay: {
      apiBase: easyPayBase,
      submitUrl: process.env.EASYPAY_SUBMIT_URL || `${easyPayBase}/submit.php`,
      pid: process.env.EASYPAY_PID || "",
      key: process.env.EASYPAY_KEY || "",
      signType: process.env.EASYPAY_SIGN_TYPE || "MD5"
    },
    plans: parsePlans()
  };
}

module.exports = { createConfig };
