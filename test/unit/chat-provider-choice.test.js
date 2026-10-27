import { test } from "node:test";
import assert from "node:assert/strict";
import { withProviderChoice } from "../../src/services/chat-provider.js";

test("the provider picked in AI Chat reaches handlers that read body.llmOpts (screenshots with Private AI)", () => {
  assert.equal(withProviderChoice({ imageBase64: "x", provider: "private" }).llmOpts.provider, "private");
  assert.equal(withProviderChoice({ provider: "builtin" }).llmOpts.provider, "none");
  // An explicit llmOpts.provider wins; nothing is added when no provider was sent.
  assert.equal(withProviderChoice({ provider: "private", llmOpts: { provider: "azure", model: "m" } }).llmOpts.provider, "azure");
  assert.equal(withProviderChoice({ message: "hi" }).llmOpts, undefined);
  // A non-string "provider" (e.g. an ITSM provider object) is left alone.
  assert.equal(withProviderChoice({ provider: { uid: 1 } }).llmOpts, undefined);
});
