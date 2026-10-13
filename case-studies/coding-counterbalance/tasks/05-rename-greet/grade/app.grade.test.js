import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as app from "../src/app.js";

describe("greet (held-out)", () => {
  it("keeps the old behaviour under the new name", () => {
    assert.equal(app.greet("Grace"), "hi Grace");
    assert.equal(app.greet(""), "hi ");
  });
  it("is a rename, not an alias", () => assert.equal(app.hello, undefined));
});
