const state = {
  adminProducts: [],
  adminOrders: [],
  adminPassword: ""
};

const $ = (selector) => document.querySelector(selector);

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

function requireAdminPassword() {
  state.adminPassword = $("#adminPassword").value || state.adminPassword;
  if (!state.adminPassword) throw new Error("请输入管理员口令");
  return state.adminPassword;
}

async function adminApi(path, options = {}) {
  return api(path, {
    ...options,
    headers: {
      "X-Admin-Password": requireAdminPassword(),
      ...(options.headers || {})
    }
  });
}

function unlockAdmin() {
  $("#adminGate").classList.add("hidden");
  $("#adminWorkspace").classList.remove("hidden");
}

function lockAdmin() {
  state.adminPassword = "";
  state.adminProducts = [];
  state.adminOrders = [];
  $("#adminPassword").value = "";
  $("#adminGate").classList.remove("hidden");
  $("#adminWorkspace").classList.add("hidden");
  resetProductForm();
  renderAdminProducts();
  renderAdminOrders();
}

function productPayloadFromForm() {
  return {
    name: $("#productName").value,
    price: $("#productPrice").value,
    groupId: Number($("#productGroupId").value),
    validityDays: Number($("#productValidityDays").value),
    value: Number($("#productValue").value),
    quotaLabel: $("#productQuotaLabel").value,
    description: $("#productDescription").value,
    features: $("#productFeatures").value,
    enabled: $("#productEnabled").checked,
    sort: Number($("#productSort").value || 100)
  };
}

function resetProductForm() {
  $("#productForm").reset();
  $("#productId").value = "";
  $("#productEnabled").checked = true;
  $("#productFormTitle").textContent = "新增商品";
  $("#cancelEditProductBtn").classList.add("hidden");
}

function fillProductForm(product) {
  $("#productId").value = product.id;
  $("#productName").value = product.name;
  $("#productPrice").value = product.price;
  $("#productGroupId").value = product.groupId;
  $("#productValidityDays").value = product.validityDays;
  $("#productValue").value = product.value;
  $("#productQuotaLabel").value = product.quotaLabel || "";
  $("#productDescription").value = product.description || "";
  $("#productFeatures").value = (product.features || []).join("\n");
  $("#productEnabled").checked = product.enabled !== false;
  $("#productSort").value = product.sort ?? 100;
  $("#productFormTitle").textContent = `编辑商品：${product.name}`;
  $("#cancelEditProductBtn").classList.remove("hidden");
}

function renderAdminProducts() {
  const box = $("#productList");
  if (!state.adminProducts.length) {
    box.innerHTML = `<div class="empty-state"><strong>暂无商品</strong><span class="empty-state-text">填写左侧表单新增第一个商品。</span></div>`;
    return;
  }

  box.innerHTML = state.adminProducts
    .map(
      (product) => `
        <article class="product-row" data-product-id="${escapeHtml(product.id)}">
          <div>
            <strong>${escapeHtml(product.name)}</strong>
            <span>${escapeHtml(product.description || "无描述")}</span>
          </div>
          <div>
            <span class="label">价格</span>
            <strong>¥${escapeHtml(product.price)}</strong>
          </div>
          <div>
            <span class="label">分组</span>
            <strong>${escapeHtml(product.groupId)}</strong>
          </div>
          <div>
            <span class="state ${product.enabled ? "completed" : "expired"}">${product.enabled ? "已上架" : "已下架"}</span>
          </div>
          <div class="product-actions">
            <button class="ghost" type="button" data-action="edit">编辑</button>
            <button class="ghost" type="button" data-action="toggle">${product.enabled ? "下架" : "上架"}</button>
            <button class="ghost danger" type="button" data-action="delete">删除</button>
          </div>
        </article>
      `
    )
    .join("");

  box.querySelectorAll(".product-row").forEach((row) => {
    row.addEventListener("click", (event) => handleProductAction(row.dataset.productId, event));
  });
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

function formatCountdown(seconds) {
  const safe = Math.max(0, Number(seconds || 0));
  const minutes = Math.floor(safe / 60);
  const rest = safe % 60;
  return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
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

function orderTimeText(order) {
  if (!order) return "-";
  if (order.status === "pending") return formatCountdown(order.remainingSeconds || 0);
  if (order.status === "expired") return `关闭于 ${formatDate(order.updatedAt)}`;
  if (order.status === "completed") return order.subscriptionExpiresAt ? `到期 ${formatDate(order.subscriptionExpiresAt)}` : `完成于 ${formatDate(order.deliveredAt || order.updatedAt)}`;
  if (order.status === "failed") return `失败于 ${formatDate(order.updatedAt)}`;
  if (order.status === "paid") return `支付于 ${formatDate(order.paidAt || order.updatedAt)}`;
  return "-";
}

function renderAdminOrders() {
  const box = $("#adminOrderList");
  if (!state.adminOrders.length) {
    box.innerHTML = `<div class="empty-state"><strong>暂无订单</strong><span class="empty-state-text">用户下单后会显示在这里。</span></div>`;
    return;
  }

  box.innerHTML = state.adminOrders
    .map(
      (order) => `
        <article class="admin-order-row" data-order-id="${escapeHtml(order.id)}">
          <div>
            <strong>${escapeHtml(order.planName)}</strong>
            <span>${escapeHtml(order.id)}</span>
          </div>
          <div>
            <span class="label">金额</span>
            <strong>¥${escapeHtml(order.amount)}</strong>
          </div>
          <div>
            <span class="label">状态</span>
            <span class="state ${escapeHtml(order.status)}">${escapeHtml(statusText(order.status))}</span>
          </div>
          <div>
            <span class="label">支付倒计时/时间</span>
            <strong>${escapeHtml(orderTimeText(order))}</strong>
          </div>
          <div class="product-actions">
            <button class="ghost" type="button" data-action="copy">复制订单号</button>
            <button class="ghost" type="button" data-action="fill">填入调试</button>
            <button class="primary" type="button" data-action="debug">模拟成功</button>
          </div>
        </article>
      `
    )
    .join("");

  box.querySelectorAll(".admin-order-row").forEach((row) => {
    row.addEventListener("click", (event) => handleAdminOrderAction(row.dataset.orderId, event));
  });
}

async function loadAdminProducts() {
  const data = await adminApi("/api/admin/products");
  state.adminProducts = data.products || [];
  unlockAdmin();
  renderAdminProducts();
  await loadAdminOrders();
}

async function loadAdminOrders() {
  const data = await adminApi("/api/admin/orders?limit=50");
  state.adminOrders = data.orders || [];
  renderAdminOrders();
}

async function saveProduct(event) {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button[type='submit']");
  setBusy(button, true);
  try {
    const productId = $("#productId").value;
    const payload = productPayloadFromForm();
    const method = productId ? "PUT" : "POST";
    const path = productId ? `/api/admin/products/${encodeURIComponent(productId)}` : "/api/admin/products";
    await adminApi(path, {
      method,
      body: JSON.stringify(payload)
    });
    resetProductForm();
    await loadAdminProducts();
    showToast("商品已保存", "success");
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    setBusy(button, false);
  }
}

async function handleProductAction(productId, event) {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const product = state.adminProducts.find((item) => item.id === productId);
  if (!product) return;

  if (button.dataset.action === "edit") {
    fillProductForm(product);
    return;
  }

  setBusy(button, true);
  try {
    if (button.dataset.action === "toggle") {
      await adminApi(`/api/admin/products/${encodeURIComponent(product.id)}`, {
        method: "PUT",
        body: JSON.stringify({ ...product, enabled: !product.enabled })
      });
      showToast(product.enabled ? "商品已下架" : "商品已上架", "success");
    }
    if (button.dataset.action === "delete") {
      if (!confirm(`确认删除商品「${product.name}」？已创建订单不会受影响。`)) return;
      await adminApi(`/api/admin/products/${encodeURIComponent(product.id)}`, {
        method: "DELETE"
      });
      showToast("商品已删除", "success");
    }
    await loadAdminProducts();
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    setBusy(button, false);
  }
}

async function debugCompleteOrder(event) {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button[type='submit']");
  setBusy(button, true);
  try {
    const orderId = $("#debugOrderId").value.trim();
    const gatewayTradeNo = $("#debugTradeNo").value.trim();
    const data = await adminApi(`/api/admin/orders/${encodeURIComponent(orderId)}/debug-complete`, {
      method: "POST",
      body: JSON.stringify({ gatewayTradeNo })
    });
    $("#debugResult").textContent = JSON.stringify(data, null, 2);
    showToast("调试发放已执行", "success");
  } catch (error) {
    $("#debugResult").textContent = error.message;
    showToast(error.message, "error");
  } finally {
    setBusy(button, false);
  }
}

async function copyText(value) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const input = document.createElement("textarea");
  input.value = value;
  input.style.position = "fixed";
  input.style.left = "-9999px";
  document.body.appendChild(input);
  input.focus();
  input.select();
  document.execCommand("copy");
  input.remove();
}

async function handleAdminOrderAction(orderId, event) {
  const button = event.target.closest("button[data-action]");
  if (!button) return;

  if (button.dataset.action === "copy") {
    await copyText(orderId);
    showToast("订单号已复制", "success");
    return;
  }

  if (button.dataset.action === "fill") {
    $("#debugOrderId").value = orderId;
    $("#debugTradeNo").focus();
    showToast("已填入调试表单");
    return;
  }

  if (button.dataset.action === "debug") {
    $("#debugOrderId").value = orderId;
    await debugCompleteOrder({ preventDefault() {}, currentTarget: $("#debugCompleteForm") });
    await loadAdminOrders();
  }
}

function boot() {
  $("#loadProductsBtn").addEventListener("click", () =>
    loadAdminProducts().catch((error) => showToast(error.message, "error"))
  );
  $("#refreshProductsBtn").addEventListener("click", () =>
    loadAdminProducts().catch((error) => showToast(error.message, "error"))
  );
  $("#refreshAdminOrdersBtn").addEventListener("click", () =>
    loadAdminOrders().catch((error) => showToast(error.message, "error"))
  );
  $("#lockAdminBtn").addEventListener("click", lockAdmin);
  $("#productForm").addEventListener("submit", saveProduct);
  $("#debugCompleteForm").addEventListener("submit", debugCompleteOrder);
  $("#cancelEditProductBtn").addEventListener("click", resetProductForm);
  $("#adminPassword").addEventListener("keydown", (event) => {
    if (event.key === "Enter") loadAdminProducts().catch((error) => showToast(error.message, "error"));
  });
}

boot();
