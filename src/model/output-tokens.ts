export const DEFAULT_MAX_OUTPUT_TOKENS = 32_000

export function rethrowWithOutputTokenHint(error: unknown): never {
  if (error instanceof Error && 'status' in error && error.status === 400) {
    const detail = `${'param' in error ? String(error.param) : ''} ${error.message}`
    if (
      /max(?:[_ ](?:output|completion))?[_ ]tokens/i.test(detail) &&
      /too (?:large|high|many)|exceed|at most|less than|maximum|range|between|limit|[<>]/i.test(
        detail,
      )
    ) {
      error.message +=
        '\nIf the requested output limit is too large for this model, lower providers.<provider>.maxOutputTokens in your Dock settings.json.'
    }
  }
  throw error
}
