const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { formatMoney } = require("./easypay");

function slugify(value) {
  const slug = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || `product-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
}

function boolValue(value, fallback = true) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return !["false", "0", "off", "no"].includes(String(value).toLowerCase());
}

function normalizeFeatures(value) {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  if (typeof value === "string") {
    return value
      .split(/\r?\n|,/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function normalizeProduct(input, existing = null) {
  const merged = { ...(existing || {}), ...(input || {}) };
  const id = existing?.id || slugify(merged.id || merged.name);
  const name = String(merged.name || "").trim();
  if (!name) throw new Error("商品名称不能为空");

  const price = formatMoney(merged.price);
  const groupId = Number(merged.groupId);
  const validityDays = Number(merged.validityDays);
  const value = Number(merged.value || validityDays);
  if (!Number.isFinite(groupId) || groupId <= 0) throw new Error("订阅分组 ID 必须大于 0");
  if (!Number.isFinite(validityDays) || validityDays <= 0) throw new Error("有效天数必须大于 0");
  if (!Number.isFinite(value) || value <= 0) throw new Error("发放值必须大于 0");

  const now = new Date().toISOString();
  return {
    id,
    name,
    price,
    groupId,
    validityDays,
    value,
    quotaLabel: String(merged.quotaLabel || `${validityDays} 天`).trim(),
    description: String(merged.description || "").trim(),
    features: normalizeFeatures(merged.features),
    enabled: boolValue(merged.enabled, true),
    sort: Number.isFinite(Number(merged.sort)) ? Number(merged.sort) : 100,
    createdAt: existing?.createdAt || now,
    updatedAt: now
  };
}

class ProductStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.filePath = path.join(dataDir, "products.json");
    this.queue = Promise.resolve();
  }

  async init(seedProducts = []) {
    await fs.mkdir(this.dataDir, { recursive: true });
    try {
      await fs.access(this.filePath);
    } catch {
      const products = seedProducts.map((product, index) =>
        normalizeProduct({ ...product, sort: product.sort ?? (index + 1) * 10 })
      );
      await this.write({ products });
    }
  }

  async read() {
    const raw = await fs.readFile(this.filePath, "utf8");
    const parsed = JSON.parse(raw || "{}");
    return { products: Array.isArray(parsed.products) ? parsed.products : [] };
  }

  async write(data) {
    const tmpPath = `${this.filePath}.${process.pid}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), "utf8");
    await fs.rename(tmpPath, this.filePath);
  }

  async withLock(task) {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => {});
    return run;
  }

  sort(products) {
    return [...products].sort((a, b) => Number(a.sort || 0) - Number(b.sort || 0) || a.name.localeCompare(b.name));
  }

  async list({ includeDisabled = false } = {}) {
    const data = await this.read();
    const products = includeDisabled ? data.products : data.products.filter((product) => product.enabled !== false);
    return this.sort(products);
  }

  async get(id) {
    const data = await this.read();
    return data.products.find((product) => product.id === id) || null;
  }

  async create(input) {
    return this.withLock(async () => {
      const data = await this.read();
      const product = normalizeProduct(input);
      if (data.products.some((item) => item.id === product.id)) {
        throw new Error("商品 ID 已存在");
      }
      data.products.push(product);
      await this.write(data);
      return product;
    });
  }

  async update(id, input) {
    return this.withLock(async () => {
      const data = await this.read();
      const index = data.products.findIndex((product) => product.id === id);
      if (index === -1) return null;
      const product = normalizeProduct(input, data.products[index]);
      data.products[index] = product;
      await this.write(data);
      return product;
    });
  }

  async remove(id) {
    return this.withLock(async () => {
      const data = await this.read();
      const index = data.products.findIndex((product) => product.id === id);
      if (index === -1) return false;
      data.products.splice(index, 1);
      await this.write(data);
      return true;
    });
  }
}

module.exports = { ProductStore, normalizeProduct };
