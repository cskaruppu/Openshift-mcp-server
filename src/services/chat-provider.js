// The console sends the provider picked in AI Chat as a top-level "provider"
// ("private", "azure", …); several handlers read it from body.llmOpts. Without this,
// a screenshot sent with Private AI selected was answered by the default provider.
export function withProviderChoice(body) {
  if (body && typeof body === "object" && typeof body.provider === "string" && body.provider && !(body.llmOpts && body.llmOpts.provider)) {
    body.llmOpts = { ...(body.llmOpts && typeof body.llmOpts === "object" ? body.llmOpts : {}), provider: body.provider === "builtin" ? "none" : body.provider };
  }
  return body;
}
