const test = require("node:test");
const assert = require("node:assert/strict");
const { canonicalizeParams, signParams, toCents, verifyParams } = require("../src/easypay");

test("canonicalizeParams excludes sign fields and empty values", () => {
  assert.equal(
    canonicalizeParams({
      b: "2",
      a: "1",
      sign: "ignored",
      sign_type: "MD5",
      empty: ""
    }),
    "a=1&b=2"
  );
});

test("signParams and verifyParams use EasyPay MD5 convention", () => {
  const params = {
    pid: "1000",
    type: "alipay",
    out_trade_no: "ES1",
    notify_url: "https://shop.example.com/payment/notify/easypay",
    return_url: "https://shop.example.com/payment/return/easypay",
    name: "基础月卡",
    money: "19.90"
  };
  const signed = { ...params, sign: signParams(params, "secret"), sign_type: "MD5" };
  assert.equal(verifyParams(signed, "secret"), true);
  assert.equal(verifyParams({ ...signed, money: "20.00" }, "secret"), false);
});

test("toCents handles one and two decimal amounts", () => {
  assert.equal(toCents("19.9"), 1990);
  assert.equal(toCents("19.90"), 1990);
  assert.equal(toCents("20"), 2000);
});
