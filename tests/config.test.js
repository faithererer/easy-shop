const test = require("node:test");
const assert = require("node:assert/strict");
const { createConfig } = require("../src/config");

test("createConfig uses a positive order expiration window", () => {
  const previous = process.env.ORDER_EXPIRE_MINUTES;
  delete process.env.ORDER_EXPIRE_MINUTES;
  assert.equal(createConfig().orderExpireMinutes, 15);

  process.env.ORDER_EXPIRE_MINUTES = "3";
  assert.equal(createConfig().orderExpireMinutes, 3);

  process.env.ORDER_EXPIRE_MINUTES = "0";
  assert.equal(createConfig().orderExpireMinutes, 1);

  if (previous === undefined) delete process.env.ORDER_EXPIRE_MINUTES;
  else process.env.ORDER_EXPIRE_MINUTES = previous;
});
