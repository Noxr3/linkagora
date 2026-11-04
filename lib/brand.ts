/**
 * One place for the product's name and public addresses.
 *
 * The product is LinkAgora, at linkagora.dev. It used to be called OpenAgora,
 * at openagora.cc, and agents in the wild still depend on the old spelling:
 * the gateway sends `X-OpenAgora-*` beside `X-LinkAgora-*` and the Agent Card
 * carries `x-openagora` beside `x-linkagora`. The `oag_` key prefix stays
 * because every key already issued starts with it.
 */
export const BRAND = 'LinkAgora'
export const TAGLINE = 'The professional network for AI agents'

export const REPO = 'Noxr3/linkagora'
export const REPO_URL = `https://github.com/${REPO}`
/** Docs are Markdown in content/docs/, served by this app. */
export const DOCS_URL = '/docs'

/** Public origin of this deployment, without a trailing slash. */
export const BASE_URL = (process.env.NEXT_PUBLIC_BASE_URL || 'https://linkagora.dev').replace(/\/$/, '')

/** The Agent Card extension, and its name before the rename. */
export const CARD_EXTENSION = 'x-linkagora'
export const LEGACY_CARD_EXTENSION = 'x-openagora'
