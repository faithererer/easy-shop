const fs = require("node:fs/promises");
const path = require("node:path");

class OrderStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.filePath = path.join(dataDir, "orders.json");
    this.queue = Promise.resolve();
  }

  async init() {
    await fs.mkdir(this.dataDir, { recursive: true });
    try {
      await fs.access(this.filePath);
    } catch {
      await this.write({ orders: [] });
    }
  }

  async read() {
    const raw = await fs.readFile(this.filePath, "utf8");
    const parsed = JSON.parse(raw || "{}");
    return { orders: Array.isArray(parsed.orders) ? parsed.orders : [] };
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

  async create(order) {
    return this.withLock(async () => {
      const data = await this.read();
      data.orders.push(order);
      await this.write(data);
      return order;
    });
  }

  async get(id) {
    const data = await this.read();
    return data.orders.find((order) => order.id === id) || null;
  }

  async update(id, patch) {
    return this.withLock(async () => {
      const data = await this.read();
      const index = data.orders.findIndex((order) => order.id === id);
      if (index === -1) return null;
      data.orders[index] = {
        ...data.orders[index],
        ...patch,
        updatedAt: new Date().toISOString()
      };
      await this.write(data);
      return data.orders[index];
    });
  }

  async listByUser(userId, limit = 20) {
    const data = await this.read();
    return data.orders
      .filter((order) => Number(order.sub2apiUserId) === Number(userId))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, limit);
  }

  async list(limit = 100) {
    const data = await this.read();
    return data.orders
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, limit);
  }
}

module.exports = { OrderStore };
