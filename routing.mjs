export function localRouting(base, key, model, { bare = false } = {}) {
  return {
    ANTHROPIC_BASE_URL: base,
    // Normal gateway sessions use the same bearer-token path as local ccp.
    // --bare explicitly requires ANTHROPIC_API_KEY and skips normal login state.
    ANTHROPIC_AUTH_TOKEN: bare ? '' : key,
    ANTHROPIC_API_KEY: bare ? key : '',
    ANTHROPIC_MODEL: model,
    ANTHROPIC_DEFAULT_FABLE_MODEL: model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    ANTHROPIC_SMALL_FAST_MODEL: model,
    DISABLE_NON_ESSENTIAL_MODEL_CALLS: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  };
}
