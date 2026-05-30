const state = {
  config: null,
  user: null,
  orders: [],
  selectedPayType: "alipay",
  selectedFilter: "all",
  pendingTempToken: "",
  currentOrder: null,
  pollTimer: null,
  countdownTimer: null
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {})
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "请求失败");
  return data;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function showToast(message, type = "info") {
  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `
    <span class="toast-message">${escapeHtml(message)}</span>
    <button class="toast-close" type="button" aria-label="关闭">×</button>
    <span class="toast-bar"></span>
  `;
  $("#toastContainer").appendChild(toast);
  toast.querySelector("button").addEventListener("click", () => removeToast(toast));
  setTimeout(() => removeToast(toast), 3200);
}

function removeToast(toast) {
  toast.classList.add("toast-out");
  setTimeout(() => toast.remove(), 220);
}

function setBusy(button, busy) {
  if (!button) return;
  button.disabled = busy;
  button.dataset.label ||= button.textContent;
  button.textContent = busy ? "处理中..." : button.dataset.label;
}

function statusText(status) {
  return {
    pending: "待支付",
    paid: "已支付",
    completed: "已开通",
    failed: "发放失败",
    expired: "已关闭"
  }[status] || status;
}

function formatDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function formatCountdown(seconds) {
  const safe = Math.max(0, Number(seconds || 0));
  const minutes = Math.floor(safe / 60);
  const rest = safe % 60;
  return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

function orderRemainingSeconds(order) {
  if (!order || order.status !== "pending") return 0;
  const end = Date.parse(order.expiresAt || "");
  if (!Number.isFinite(end)) return Number(order.remainingSeconds || 0);
  return Math.max(0, Math.floor((end - Date.now()) / 1000));
}

function orderTimeText(order) {
  if (!order) return "-";
  if (order.status === "pending") return formatCountdown(orderRemainingSeconds(order));
  if (order.status === "expired") return `关闭于 ${formatDate(order.updatedAt)}`;
  if (order.status === "completed") return order.subscriptionExpiresAt ? `到期 ${formatDate(order.subscriptionExpiresAt)}` : `完成于 ${formatDate(order.deliveredAt || order.updatedAt)}`;
  if (order.status === "failed") return `失败于 ${formatDate(order.updatedAt)}`;
  if (order.status === "paid") return `支付于 ${formatDate(order.paidAt || order.updatedAt)}`;
  return "-";
}

function subscriptionExpiresText(user) {
  if (!user) return "-";
  if (user.subscriptionExpiresAt) return formatDate(user.subscriptionExpiresAt);
  if (user.subscriptionLoaded === false) return "未返回";
  return "暂无订阅";
}

function subscriptionHintText(user) {
  if (!user) return "登录 Sub2API 后显示";
  if (user.subscriptionExpiresAt) return user.subscriptionCount > 1 ? `共 ${user.subscriptionCount} 个活跃订阅，显示最晚到期` : "来自 Sub2API 当前账号";
  if (user.subscriptionLoaded === false) return user.subscriptionError || "Sub2API 没有返回订阅信息";
  return "当前账号没有活跃订阅";
}

function toggleMenu() {
  const menu = $("#appMenu");
  const expanded = menu.classList.toggle("hidden") === false;
  $("#menuBtn").setAttribute("aria-expanded", String(expanded));
}

function closeMenu() {
  $("#appMenu").classList.add("hidden");
  $("#menuBtn").setAttribute("aria-expanded", "false");
}

function setView(viewId) {
  $$(".view").forEach((view) => view.classList.toggle("active", view.id === viewId));
  $$(".menu-item[data-view-target]").forEach((button) => button.classList.toggle("active", button.dataset.viewTarget === viewId));
  $("#pageTitle").textContent =
    {
      shopView: "购买套餐",
      ordersView: "我的订单",
      accountView: "账号登录"
    }[viewId] || "Easy Shop";
  closeMenu();
}

function renderAuth() {
  const loggedIn = Boolean(state.user);
  $("#loginForm").classList.toggle("hidden", loggedIn);
  $("#totpForm").classList.add("hidden");
  $("#logoutBtn").classList.toggle("hidden", !loggedIn);
  $("#accountText").textContent = loggedIn ? state.user.email || `用户 ${state.user.id}` : "未登录";
  $("#loginStatusPill").textContent = loggedIn ? "已连接" : "未连接";
  $("#loginStatusPill").classList.toggle("on", loggedIn);
  $("#userId").textContent = loggedIn ? state.user.id : "-";
  $("#userEmail").textContent = loggedIn ? state.user.email || "-" : "-";
  $("#subscriptionExpiresAt").textContent = loggedIn ? subscriptionExpiresText(state.user) : "-";
  $("#ordersSubscriptionExpiresAt").textContent = loggedIn ? subscriptionExpiresText(state.user) : "-";
  $("#ordersSubscriptionHint").textContent = subscriptionHintText(state.user);
  $("#avatar").textContent = loggedIn ? String(state.user.email || state.user.id).slice(0, 2).toUpperCase() : "--";
}

function renderPayTypes() {
  state.selectedPayType = "alipay";
}

function renderPlans() {
  const box = $("#plans");
  box.innerHTML = "";
  for (const [index, plan] of state.config.plans.entries()) {
    const card = document.createElement("article");
    card.className = `plan ${index === 1 ? "featured" : ""}`;
    const features = plan.features.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
    card.innerHTML = `
      <div class="plan-title">
        <h2>${escapeHtml(plan.name)}</h2>
        <span class="badge ${index === 1 ? "badge-popular" : ""}">${index === 1 ? "推荐" : escapeHtml(plan.quotaLabel)}</span>
      </div>
      <div class="price">
        <span class="price-currency">¥</span>
        <strong class="price-amount">${escapeHtml(plan.price)}</strong>
      </div>
      <p class="plan-desc">${escapeHtml(plan.description || "")}</p>
      <ul class="features">${features}</ul>
      <button class="primary" type="button">${state.user ? "立即购买" : "先登录再购买"}</button>
    `;
    card.querySelector("button").addEventListener("click", (event) => createOrder(plan.id, event.currentTarget));
    box.appendChild(card);
  }
}

function renderOrder(order) {
  state.currentOrder = order || null;
  $("#checkoutPanel").classList.toggle("hidden", !order);
  if (!order) return;

  $("#orderId").textContent = order.id;
  $("#orderPlan").textContent = order.planName;
  $("#orderStatus").textContent = statusText(order.status);
  $("#orderAmount").textContent = `¥${order.amount}`;
  $("#payBtn").classList.toggle("hidden", order.status !== "pending");
  $("#payBtn").dataset.orderId = order.id;
  $("#retryBtn").classList.toggle("hidden", !["paid", "failed"].includes(order.status));
  $("#retryBtn").dataset.orderId = order.id;
  renderCountdown();
}

function renderCountdown() {
  const order = state.currentOrder;
  if (!order) return;
  const seconds = orderRemainingSeconds(order);
  $("#orderCountdown").textContent = orderTimeText(order);
  if (order.status === "pending" && seconds <= 0) {
    order.status = "expired";
    renderOrder(order);
    loadOrders().catch(() => {});
  }
}

function filteredOrders() {
  if (state.selectedFilter === "all") return state.orders;
  if (state.selectedFilter === "problem") return state.orders.filter((order) => ["failed", "expired"].includes(order.status));
  return state.orders.filter((order) => order.status === state.selectedFilter);
}

function renderOrders() {
  $("#navOrderCount").textContent = state.orders.length;
  $("#ordersSubscriptionExpiresAt").textContent = state.user ? subscriptionExpiresText(state.user) : "-";
  $("#ordersSubscriptionHint").textContent = subscriptionHintText(state.user);
  const list = filteredOrders();
  const box = $("#ordersList");
  if (!state.user) {
    box.innerHTML = `<div class="empty-state"><strong>还未登录</strong><span class="empty-state-text">登录 Sub2API 账号后查看订单。</span></div>`;
    return;
  }
  if (!list.length) {
    box.innerHTML = `<div class="empty-state"><strong>没有匹配订单</strong><span class="empty-state-text">切换筛选或购买一个套餐。</span></div>`;
    return;
  }

  box.innerHTML = list
    .map((order) => {
      const displayOrder =
        order.status === "completed" && !order.subscriptionExpiresAt && state.user?.subscriptionExpiresAt
          ? { ...order, subscriptionExpiresAt: state.user.subscriptionExpiresAt }
          : order;
      const remain = orderTimeText(displayOrder);
      const action =
        order.status === "pending"
          ? "继续支付"
          : ["paid", "failed"].includes(order.status)
            ? "重试发放"
            : "查看详情";
      return `
        <button class="order-row" type="button" data-order-id="${escapeHtml(order.id)}" data-order-status="${escapeHtml(order.status)}">
          <span>${escapeHtml(order.planName)}</span>
          <span>${escapeHtml(order.id)}</span>
          <span>¥${escapeHtml(order.amount)}</span>
          <span class="state ${escapeHtml(order.status)}">${escapeHtml(statusText(order.status))}</span>
          <span class="order-time">${escapeHtml(remain)}</span>
          <span class="row-action">${action}</span>
        </button>
      `;
    })
    .join("");

  box.querySelectorAll("[data-order-id]").forEach((row) => {
    row.addEventListener("click", () => handleOrderRow(row.dataset.orderId, row.dataset.orderStatus));
  });
}

function renderOrderFilters() {
  $$("#orderFilters button").forEach((button) => {
    button.classList.toggle("active", button.dataset.filter === state.selectedFilter);
  });
}

async function handleOrderRow(orderId, status) {
  if (status === "pending") return resumePayment(orderId);
  if (["paid", "failed"].includes(status)) return retryDelivery(orderId);
  await loadOrder(orderId, false);
  setView("shopView");
}

async function loadConfig() {
  state.config = await api("/api/config");
  $("#siteName").textContent = state.config.siteName;
  document.title = state.config.siteName;
  renderPayTypes();
  renderPlans();
}

async function loadProducts() {
  const data = await api("/api/products");
  state.config.plans = data.products || [];
  renderPlans();
}

async function loadMe() {
  try {
    const data = await api("/api/me");
    state.user = data.user;
  } catch {
    state.user = null;
  }
  renderAuth();
  renderPlans();
}

async function loadOrders() {
  if (!state.user) {
    state.orders = [];
    renderOrders();
    return;
  }
  const data = await api("/api/orders");
  state.orders = data.orders || [];
  renderOrders();
}

async function loadOrder(orderId, shouldPoll = true) {
  if (!orderId || !state.user) return;
  const data = await api(`/api/orders/${encodeURIComponent(orderId)}`);
  renderOrder(data.order);
  if (shouldPoll && ["pending", "paid", "failed"].includes(data.order.status)) startPolling(orderId);
}

function startPolling(orderId) {
  clearInterval(state.pollTimer);
  state.pollTimer = setInterval(async () => {
    try {
      const data = await api(`/api/orders/${encodeURIComponent(orderId)}`);
      renderOrder(data.order);
      if (["completed", "failed", "expired"].includes(data.order.status)) {
        clearInterval(state.pollTimer);
        if (data.order.status === "completed") await loadMe();
        await loadOrders();
      }
    } catch {
      clearInterval(state.pollTimer);
    }
  }, 2500);
}

async function createOrder(planId, button) {
  if (!state.user) {
    setView("accountView");
    showToast("请先登录 Sub2API 账号");
    return;
  }
  setBusy(button, true);
  try {
    const data = await api("/api/orders", {
      method: "POST",
      body: JSON.stringify({ planId, payType: state.selectedPayType })
    });
    renderOrder(data.order);
    await loadOrders();
    window.location.href = data.payUrl;
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    setBusy(button, false);
  }
}

async function resumePayment(orderId, button) {
  if (!state.user) {
    showToast("请先登录 Sub2API 账号");
    return;
  }
  setBusy(button, true);
  try {
    const data = await api(`/api/orders/${encodeURIComponent(orderId)}/pay`, {
      method: "POST",
      body: JSON.stringify({ payType: state.selectedPayType })
    });
    renderOrder(data.order);
    window.location.href = data.payUrl;
  } catch (error) {
    await loadOrders();
    showToast(error.message, "error");
  } finally {
    setBusy(button, false);
  }
}

async function login(event) {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button");
  setBusy(button, true);
  try {
    const data = await api("/api/login", {
      method: "POST",
      body: JSON.stringify({
        email: $("#email").value,
        password: $("#password").value
      })
    });

    if (data.requires2FA) {
      state.pendingTempToken = data.tempToken;
      $("#loginForm").classList.add("hidden");
      $("#totpForm").classList.remove("hidden");
      $("#totpCode").focus();
      showToast("请输入二次验证码");
      return;
    }

    state.user = data.user;
    renderAuth();
    renderPlans();
    await loadOrders();
    setView("shopView");
    showToast("登录成功", "success");
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    setBusy(button, false);
  }
}

async function login2FA(event) {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button");
  setBusy(button, true);
  try {
    const data = await api("/api/login/2fa", {
      method: "POST",
      body: JSON.stringify({
        tempToken: state.pendingTempToken,
        totpCode: $("#totpCode").value
      })
    });
    state.user = data.user;
    state.pendingTempToken = "";
    renderAuth();
    renderPlans();
    await loadOrders();
    setView("shopView");
    showToast("登录成功", "success");
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    setBusy(button, false);
  }
}

async function logout() {
  await api("/api/logout", { method: "POST", body: "{}" }).catch(() => {});
  state.user = null;
  state.orders = [];
  state.currentOrder = null;
  renderAuth();
  renderPlans();
  renderOrders();
  renderOrder(null);
  showToast("已退出登录");
}

async function retryDelivery(orderId = $("#retryBtn").dataset.orderId) {
  if (!orderId) return;
  try {
    const data = await api(`/api/orders/${encodeURIComponent(orderId)}/retry`, {
      method: "POST",
      body: "{}"
    });
    renderOrder(data.order);
    if (data.order.status === "completed") await loadMe();
    await loadOrders();
    showToast("已重新尝试发放", "success");
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function boot() {
  $$(".menu-item[data-view-target]").forEach((button) => {
    button.addEventListener("click", () => setView(button.dataset.viewTarget));
  });
  $("#menuBtn").addEventListener("click", (event) => {
    event.stopPropagation();
    toggleMenu();
  });
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".header-actions")) closeMenu();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeMenu();
  });
  $$("#orderFilters button").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedFilter = button.dataset.filter;
      renderOrderFilters();
      renderOrders();
    });
  });
  $("#loginForm").addEventListener("submit", login);
  $("#totpForm").addEventListener("submit", login2FA);
  $("#logoutBtn").addEventListener("click", logout);
  $("#refreshOrdersBtn").addEventListener("click", loadOrders);
  $("#payBtn").addEventListener("click", () => resumePayment($("#payBtn").dataset.orderId, $("#payBtn")));
  $("#retryBtn").addEventListener("click", () => retryDelivery());

  await loadConfig();
  await loadMe();
  await loadOrders();
  renderOrderFilters();

  clearInterval(state.countdownTimer);
  state.countdownTimer = setInterval(() => {
    renderCountdown();
    if (state.orders.some((order) => order.status === "pending")) renderOrders();
  }, 1000);

  const orderId = new URLSearchParams(window.location.search).get("order");
  if (orderId) {
    await loadOrder(orderId, true);
    await loadOrders();
    setView("shopView");
  }
}

boot().catch((error) => showToast(error.message, "error"));
