import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startStubHomebox } from "./helpers/stub-homebox.mjs";
import { startShim, tempDir } from "./helpers/shim.mjs";

/** Extract the text of a tools/call reply, asserting it was a tool error. */
function toolError(res) {
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.error, undefined, `expected a tool error, got a transport error: ${res.text}`);
  assert.equal(res.body.result.isError, true, `expected isError:true, got ${res.text}`);
  return res.body.result.content[0].text;
}

describe("inbox path traversal", () => {
  let homebox;
  let shim;
  let inbox;
  let outside;

  before(async () => {
    homebox = await startStubHomebox();

    inbox = tempDir("homebox-inbox-");
    fs.writeFileSync(path.join(inbox, "receipt.pdf"), "%PDF-1.4 stub receipt\n");

    // A file the inbox must never be able to reach, plus a symlink pointing at it.
    outside = tempDir("homebox-outside-");
    const secret = path.join(outside, "secret.txt");
    fs.writeFileSync(secret, "top secret\n");
    fs.symlinkSync(secret, path.join(inbox, "escape.pdf"));
    fs.symlinkSync("/etc/passwd", path.join(inbox, "passwd-link.pdf"));

    shim = await startShim({ homeboxUrl: homebox.url, env: { INBOX_PATH: inbox } });
  });

  after(async () => {
    await shim?.stop();
    await homebox?.close();
    fs.rmSync(inbox, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it("lists the inbox as mounted with the real file", async () => {
    const res = await shim.callTool("list_inbox");
    assert.equal(res.status, 200);
    const out = JSON.parse(res.body.result.content[0].text);
    assert.equal(out.mounted, true);
    assert.ok(
      out.files.some((f) => f.file === "receipt.pdf"),
      `receipt.pdf missing from ${JSON.stringify(out.files)}`
    );
  });

  it("refuses a ../ traversal", async () => {
    const msg = toolError(
      await shim.callTool("upload_attachment", { id: "ent-1", file: "../../etc/passwd" })
    );
    assert.match(msg, /refused|outside the inbox/i, msg);
  });

  it("refuses a deeper ../ traversal into a sibling temp dir", async () => {
    const rel = path.relative(inbox, path.join(outside, "secret.txt"));
    const msg = toolError(await shim.callTool("upload_attachment", { id: "ent-1", file: rel }));
    assert.match(msg, /refused|outside the inbox/i, msg);
  });

  it("refuses an absolute path", async () => {
    const msg = toolError(
      await shim.callTool("upload_attachment", { id: "ent-1", file: "/etc/passwd" })
    );
    assert.match(msg, /refused|outside the inbox/i, msg);
  });

  it("refuses a symlink pointing outside the inbox", async () => {
    const msg = toolError(
      await shim.callTool("upload_attachment", { id: "ent-1", file: "escape.pdf" })
    );
    assert.match(msg, /refused|outside the inbox/i, msg);
  });

  it("refuses a symlink to /etc/passwd", async () => {
    const msg = toolError(
      await shim.callTool("upload_attachment", { id: "ent-1", file: "passwd-link.pdf" })
    );
    assert.match(msg, /refused|outside the inbox/i, msg);
  });

  it("does not leak file contents on a refusal", async () => {
    const msg = toolError(
      await shim.callTool("upload_attachment", { id: "ent-1", file: "escape.pdf" })
    );
    assert.ok(!msg.includes("top secret"), "refusal message leaked the target file's contents");
  });

  it("accepts the legitimate filename inside the inbox", async () => {
    const res = await shim.callTool("upload_attachment", {
      id: "ent-1",
      file: "receipt.pdf",
      type: "receipt",
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.result.isError, false, res.body.result.content[0].text);
    const out = JSON.parse(res.body.result.content[0].text);
    assert.equal(out.uploaded, "receipt.pdf");

    const upload = homebox.requests.find((r) => r.path.endsWith("/attachments"));
    assert.ok(upload, "Homebox never received the upload");
    assert.match(upload.headers["content-type"], /^multipart\/form-data; boundary=/);
    assert.ok(upload.text.includes("%PDF-1.4 stub receipt"), "file bytes did not reach Homebox");
  });

  it("rejects an unknown attachment type", async () => {
    const msg = toolError(
      await shim.callTool("upload_attachment", { id: "ent-1", file: "receipt.pdf", type: "bogus" })
    );
    assert.match(msg, /type must be one of/i, msg);
  });
});

describe("inbox not mounted", () => {
  let homebox;
  let shim;

  before(async () => {
    homebox = await startStubHomebox();
    shim = await startShim({
      homeboxUrl: homebox.url,
      env: { INBOX_PATH: path.join(tempDir("homebox-noinbox-"), "does-not-exist") },
    });
  });

  after(async () => {
    await shim?.stop();
    await homebox?.close();
  });

  it("list_inbox reports mounted:false and no files", async () => {
    const res = await shim.callTool("list_inbox");
    assert.equal(res.status, 200);
    const out = JSON.parse(res.body.result.content[0].text);
    assert.equal(out.mounted, false);
    assert.deepEqual(out.files, []);
  });

  it("upload_attachment fails cleanly when the inbox is missing", async () => {
    const msg = toolError(
      await shim.callTool("upload_attachment", { id: "ent-1", file: "anything.pdf" })
    );
    assert.match(msg, /not found|refused/i, msg);
  });
});
