import assert from "node:assert/strict";
import WebSocket from "ws";

const base = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
const created = await fetch(`${base}/api/sessions`, {
  method: "POST",
  headers: { "content-type": "application/json", origin: "null" },
  body: "{}"
});
assert.equal(created.status, 201);
assert.equal(created.headers.get("access-control-allow-origin"), "*");
const session = await created.json();
assert.ok(session.id && session.publisherToken && session.viewerUrl && session.publisherWsUrl);

const viewerWsUrl = session.viewerUrl
  .replace(/^http:/, "ws:")
  .replace(/^https:/, "wss:")
  .replace("/s/", "/ws/view/");
const viewer = new WebSocket(viewerWsUrl);
const publisher = new WebSocket(session.publisherWsUrl);

await Promise.all([
  new Promise((resolve, reject) => viewer.once("open", resolve).once("error", reject)),
  new Promise((resolve, reject) => publisher.once("open", resolve).once("error", reject))
]);

const frameNotice = new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("frame notification timeout")), 5000);
  viewer.on("message", raw => {
    const message = JSON.parse(raw.toString());
    if (message.type === "frame") {
      clearTimeout(timeout);
      resolve(message);
    }
  });
});

const image = Buffer.from("ffd8ffe000104a4649460001", "hex");
const uploaded = await fetch(`${base}/api/sessions/${session.id}/frame`, {
  method: "PUT",
  headers: {
    authorization: `Bearer ${session.publisherToken}`,
    "content-type": "image/jpeg",
    "x-frame-name": encodeURIComponent("正式版测试"),
    "x-frame-width": "375",
    "x-frame-height": "812",
    "x-frame-scale": "1",
    "x-frame-stage": "fast"
  },
  body: image
});
assert.equal(uploaded.status, 200);
const notice = await frameNotice;
assert.equal(notice.name, "正式版测试");
assert.equal(notice.scale, 1);

const downloaded = await fetch(new URL(notice.imageUrl, base));
assert.equal(downloaded.status, 200);
assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), image);

const deleted = await fetch(`${base}/api/sessions/${session.id}`, {
  method: "DELETE",
  headers: { authorization: `Bearer ${session.publisherToken}` }
});
assert.equal(deleted.status, 204);
const missing = await fetch(new URL(notice.imageUrl, base));
assert.equal(missing.status, 404);

viewer.close();
publisher.close();
console.log("production flow: OK");
