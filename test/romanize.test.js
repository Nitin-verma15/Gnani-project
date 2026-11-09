import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { romanize } from "../public/romanize.js";
import { createDemoClient } from "../src/demo.js";

test("common shop words come out in familiar spelling", () => {
  const words = {
    रमेश: "ramesh", उधार: "udhaar", दिया: "diya", हिसाब: "hisaab", करना: "karna",
    बाकी: "baaki", आज: "aaj", सामान: "saamaan", खर्चा: "kharcha", का: "ka", को: "ko",
    "५००": "500", ज़रा: "zara",
  };
  for (const [hindi, roman] of Object.entries(words)) assert.equal(romanize(hindi), roman);
});

test("mixed text keeps Latin letters, digits and punctuation untouched", () => {
  assert.equal(romanize("रमेश को ₹500 credit, OK?"), "ramesh ko ₹500 credit, OK?");
  assert.equal(romanize("Already English 123"), "Already English 123");
  assert.equal(romanize(undefined), "");
});

test("no Devanagari is left in any full sentence", () => {
  const out = romanize("आज का हिसाब बताओ। किसका कितना उधार बाकी है?");
  assert.doesNotMatch(out, /[ऀ-ॿ]/);
});

test("demo mode understands Hindi script speech", async () => {
  const stream = createDemoClient().beta.messages.stream({
    messages: [{ role: "user", content: [{ type: "text", text: "ctx" }, { type: "text", text: "रमेश को 500 उधार दिया" }] }],
  });
  const { content } = await stream.finalMessage();
  assert.equal(content[0].name, "record_sale");
  assert.equal(content[0].input.amount, 500);
  assert.equal(content[0].input.customer_name, "Ramesh");
});

test("the website itself has no Devanagari text", () => {
  for (const file of ["index.html", "app.js"]) {
    assert.doesNotMatch(readFileSync(new URL(`../public/${file}`, import.meta.url), "utf8"), /[ऀ-ॿ]/, file);
  }
});
