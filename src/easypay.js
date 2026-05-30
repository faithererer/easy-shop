const crypto = require("node:crypto");

function toCents(amount) {
  const text = String(amount).trim();
  if (!/^\d+(\.\d{1,2})?$/.test(text)) {
    throw new Error(`invalid money amount: ${amount}`);
  }
  const [yuan, fen = ""] = text.split(".");
  return Number(yuan) * 100 + Number(fen.padEnd(2, "0"));
}

function formatMoney(amount) {
  return (toCents(amount) / 100).toFixed(2);
}

function canonicalizeParams(params) {
  return Object.keys(params)
    .filter((key) => key !== "sign" && key !== "sign_type")
    .filter((key) => params[key] !== undefined && params[key] !== null && String(params[key]) !== "")
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join("&");
}

function signParams(params, key) {
  const raw = canonicalizeParams(params) + key;
  return crypto.createHash("md5").update(raw, "utf8").digest("hex");
}

function timingSafeEqualText(a, b) {
  const left = Buffer.from(String(a || "").toLowerCase());
  const right = Buffer.from(String(b || "").toLowerCase());
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function verifyParams(params, key) {
  if (!params || !params.sign) return false;
  const expected = signParams(params, key);
  return timingSafeEqualText(expected, params.sign);
}

function buildPaymentUrl({ easyPay, order, plan, publicBaseUrl, siteName, payType }) {
  if (!easyPay.submitUrl || !easyPay.pid || !easyPay.key) {
    throw new Error("EasyPay is not configured");
  }

  const params = {
    pid: easyPay.pid,
    type: payType,
    out_trade_no: order.id,
    notify_url: `${publicBaseUrl}/payment/notify/easypay`,
    return_url: `${publicBaseUrl}/payment/return/easypay?order=${encodeURIComponent(order.id)}`,
    name: plan.name,
    money: formatMoney(plan.price),
    sitename: siteName
  };

  params.sign = signParams(params, easyPay.key);
  params.sign_type = easyPay.signType || "MD5";

  const url = new URL(easyPay.submitUrl);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

module.exports = {
  buildPaymentUrl,
  canonicalizeParams,
  formatMoney,
  signParams,
  toCents,
  verifyParams
};
