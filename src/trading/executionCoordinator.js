const { AsyncLocalStorage } = require("async_hooks");

class ExecutionCoordinator {
  constructor() {
    this._queues = new Map();
    this._active = new Map();
    this._als = new AsyncLocalStorage();
  }

  async run({ key, type, meta = null } = {}, handler) {
    const normalizedKey = String(key || "");
    if (!normalizedKey || typeof handler !== "function") {
      return handler ? handler(null) : undefined;
    }

    const activeContext = this._als.getStore();
    if (activeContext?.key === normalizedKey) {
      return handler(activeContext);
    }

    const previous = this._queues.get(normalizedKey) || Promise.resolve();
    const context = {
      key: normalizedKey,
      type: String(type || "UNKNOWN"),
      meta: meta || null,
      startedAt: Date.now(),
    };

    const runPromise = previous
      .catch(() => {})
      .then(async () => {
        this._active.set(normalizedKey, context);
        try {
          return await this._als.run(context, () => handler(context));
        } finally {
          if (this._active.get(normalizedKey) === context) {
            this._active.delete(normalizedKey);
          }
        }
      });

    const trackedPromise = runPromise.finally(() => {
      if (this._queues.get(normalizedKey) === trackedPromise) {
        this._queues.delete(normalizedKey);
      }
    });

    this._queues.set(normalizedKey, trackedPromise);
    return trackedPromise;
  }

  getActiveCommand(key) {
    const normalizedKey = String(key || "");
    return normalizedKey ? this._active.get(normalizedKey) || null : null;
  }

  getCurrentCommand() {
    return this._als.getStore() || null;
  }
}

module.exports = { ExecutionCoordinator };
