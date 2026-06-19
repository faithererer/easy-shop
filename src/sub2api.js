function joinUrl(baseUrl, path) {
  return `${String(baseUrl).replace(/\/+$/, "")}/${String(path).replace(/^\/+/, "")}`;
}

function unwrapResponse(json) {
  if (!json || typeof json !== "object") return json;
  if (json.data && typeof json.data === "object") return json.data;
  if (json.result && typeof json.result === "object") return json.result;
  return json;
}

function pick(obj, keys) {
  if (!obj || typeof obj !== "object") return undefined;
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null) return obj[key];
  }
  return undefined;
}

function normalizeDate(value) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value === "number") {
    const millis = value > 9999999999 ? value : value * 1000;
    const date = new Date(millis);
    return Number.isNaN(date.getTime()) ? "" : date.toISOString();
  }

  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function normalizeSubscription(subscription) {
  if (!subscription || typeof subscription !== "object") return null;
  const group = pick(subscription, ["group", "Group"]) || {};
  const id = pick(subscription, ["id", "ID"]);
  const groupId = pick(subscription, ["group_id", "groupId", "GroupID"]);
  return {
    id: id === undefined ? undefined : Number(id),
    groupId: groupId === undefined ? undefined : Number(groupId),
    groupName: pick(subscription, ["group_name", "groupName"]) || pick(group, ["name", "Name"]) || "",
    status: String(pick(subscription, ["status", "Status"]) || "").toLowerCase(),
    startsAt: normalizeDate(pick(subscription, ["starts_at", "startsAt", "start_at", "startAt"])),
    expiresAt: normalizeDate(
      pick(subscription, [
        "expires_at",
        "expiresAt",
        "expire_at",
        "expireAt",
        "expiration",
        "expired_at",
        "end_at",
        "endAt"
      ])
    )
  };
}

function listFromPayload(payload) {
  const data = unwrapResponse(payload);
  if (Array.isArray(data)) return data;
  const list = pick(data, ["subscriptions", "active_subscriptions", "activeSubscriptions", "items", "list", "records", "results"]);
  return Array.isArray(list) ? list : [];
}

function normalizeSubscriptions(payload) {
  return listFromPayload(payload)
    .map((subscription) => normalizeSubscription(subscription))
    .filter(Boolean);
}

function isActiveSubscription(subscription, now = Date.now()) {
  if (!subscription) return false;
  if (subscription.expiresAt) {
    const expiresAt = Date.parse(subscription.expiresAt);
    if (Number.isFinite(expiresAt) && expiresAt <= now) return false;
  }

  if (!subscription.status) return true;
  return ["active", "valid", "enabled"].includes(subscription.status);
}

function latestSubscriptionExpiresAt(subscriptions) {
  let latest = "";
  for (const subscription of subscriptions || []) {
    if (!subscription.expiresAt) continue;
    if (!latest || Date.parse(subscription.expiresAt) > Date.parse(latest)) {
      latest = subscription.expiresAt;
    }
  }
  return latest;
}

function withSubscriptionInfo(user, subscriptions) {
  const normalized = normalizeSubscriptions(subscriptions);
  const active = normalized.filter((subscription) => isActiveSubscription(subscription));
  return {
    ...user,
    subscriptions: active,
    subscriptionCount: active.length,
    subscriptionExpiresAt: latestSubscriptionExpiresAt(active),
    subscriptionLoaded: true,
    subscriptionError: ""
  };
}

function extractAuthPayload(json) {
  const data = unwrapResponse(json);
  const requires2FA = Boolean(pick(data, ["requires_2fa", "requires2FA"]));
  if (requires2FA) {
    return {
      requires2FA: true,
      tempToken: pick(data, ["temp_token", "tempToken"]),
      userEmailMasked: pick(data, ["user_email_masked", "userEmailMasked"])
    };
  }

  const accessToken = pick(data, ["access_token", "accessToken", "token"]);
  const refreshToken = pick(data, ["refresh_token", "refreshToken"]);
  const tokenType = pick(data, ["token_type", "tokenType"]) || "Bearer";
  const user = pick(data, ["user", "profile"]) || data.user || {};

  return { accessToken, refreshToken, tokenType, user };
}

function extractUserId(user) {
  const value = pick(user, ["id", "user_id", "userId", "ID"]);
  if (value === undefined) return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function normalizeUser(user) {
  if (!user || typeof user !== "object") return {};
  const embeddedSubscriptions = pick(user, ["subscriptions", "active_subscriptions", "activeSubscriptions"]);
  const base = {
    id: extractUserId(user),
    email: pick(user, ["email", "Email"]) || "",
    name: pick(user, ["name", "username", "display_name", "displayName"]) || "",
    role: pick(user, ["role", "Role"]) || "",
    raw: user
  };
  if (embeddedSubscriptions !== undefined) return withSubscriptionInfo(base, embeddedSubscriptions);
  return {
    ...base,
    subscriptions: [],
    subscriptionCount: 0,
    subscriptionExpiresAt: "",
    subscriptionLoaded: false,
    subscriptionError: ""
  };
}

class Sub2APIClient {
  constructor(config) {
    this.config = config;
  }

  async requestJson(path, options = {}) {
    const url = joinUrl(this.config.baseUrl, path);
    const timeoutMs = Number(this.config.timeoutMs || 15000);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let response;

    try {
      response = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          ...(options.body ? { "Content-Type": "application/json" } : {}),
          ...(options.headers || {})
        }
      });
    } catch (error) {
      const message =
        error.name === "AbortError"
          ? `Sub2API request timed out after ${timeoutMs}ms: ${url}`
          : `Sub2API request failed: ${url} (${error.cause?.code || error.code || error.message})`;
      const wrapped = new Error(message);
      wrapped.cause = error;
      throw wrapped;
    } finally {
      clearTimeout(timeout);
    }

    const text = await response.text();
    let json = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = { message: text };
      }
    }

    if (!response.ok) {
      const message =
        pick(unwrapResponse(json), ["message", "error", "detail"]) ||
        `Sub2API request failed with HTTP ${response.status}`;
      const error = new Error(message);
      error.status = response.status;
      error.payload = json;
      throw error;
    }

    return json;
  }

  async login({ email, password, turnstileToken }) {
    const json = await this.requestJson(this.config.endpoints.login, {
      method: "POST",
      body: JSON.stringify({
        email,
        password,
        turnstile_token: turnstileToken || ""
      })
    });
    return extractAuthPayload(json);
  }

  async login2FA({ tempToken, totpCode }) {
    const json = await this.requestJson(this.config.endpoints.login2FA, {
      method: "POST",
      body: JSON.stringify({
        temp_token: tempToken,
        totp_code: totpCode
      })
    });
    return extractAuthPayload(json);
  }

  async me(accessToken) {
    const json = await this.requestJson(this.config.endpoints.me, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    });
    return normalizeUser(unwrapResponse(json));
  }

  async activeSubscriptions(accessToken) {
    const json = await this.requestJson(this.config.endpoints.activeSubscriptions, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    });
    return normalizeSubscriptions(json);
  }

  async userSubscriptionsByAdmin(userId) {
    if (!this.config.adminApiKey) {
      throw new Error("SUB2API_ADMIN_API_KEY is not configured");
    }

    const path = this.config.endpoints.adminUserSubscriptions.replace(
      "{userId}",
      encodeURIComponent(String(userId))
    );
    const json = await this.requestJson(path, {
      method: "GET",
      headers: {
        "x-api-key": this.config.adminApiKey
      }
    });
    return normalizeSubscriptions(json);
  }

  async createAndRedeemSubscription({ order, plan, userId, idempotencyKey }) {
    if (!this.config.adminApiKey) {
      throw new Error("SUB2API_ADMIN_API_KEY is not configured");
    }

    return this.requestJson(this.config.endpoints.createAndRedeem, {
      method: "POST",
      headers: {
        "x-api-key": this.config.adminApiKey,
        "Idempotency-Key": idempotencyKey || order.id
      },
      body: JSON.stringify({
        code: `ES-${order.id}`,
        type: "subscription",
        value: Number(plan.value || plan.validityDays),
        user_id: Number(userId),
        group_id: Number(plan.groupId),
        validity_days: Number(plan.validityDays),
        notes: `Easy Shop order ${order.id}`
      })
    });
  }
}

module.exports = {
  Sub2APIClient,
  extractAuthPayload,
  extractUserId,
  isActiveSubscription,
  latestSubscriptionExpiresAt,
  normalizeSubscriptions,
  normalizeUser,
  unwrapResponse,
  withSubscriptionInfo
};
