const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeSubscriptions, withSubscriptionInfo } = require("../src/sub2api");

test("normalizeSubscriptions extracts subscription expiration dates", () => {
  const subscriptions = normalizeSubscriptions({
    code: 0,
    data: [
      {
        id: 1,
        group_id: 4,
        status: "active",
        expires_at: "2026-07-01T12:30:00+08:00",
        group: { name: "基础月卡" }
      }
    ]
  });

  assert.equal(subscriptions.length, 1);
  assert.equal(subscriptions[0].groupId, 4);
  assert.equal(subscriptions[0].groupName, "基础月卡");
  assert.equal(subscriptions[0].expiresAt, "2026-07-01T04:30:00.000Z");
});

test("withSubscriptionInfo exposes latest active subscription expiration", () => {
  const user = withSubscriptionInfo(
    { id: 2, email: "user@example.com" },
    [
      { status: "active", expires_at: "2026-06-01T00:00:00Z" },
      { status: "active", expires_at: "2026-08-01T00:00:00Z" }
    ]
  );

  assert.equal(user.subscriptionLoaded, true);
  assert.equal(user.subscriptionCount, 2);
  assert.equal(user.subscriptionExpiresAt, "2026-08-01T00:00:00.000Z");
});
