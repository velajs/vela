/**
 * Live-protocol wire version. Bumped ONLY on a breaking wire change (renaming
 * or removing a field, changing a delivery guarantee). Additive changes — new
 * optional fields, new frame types — do NOT bump it: receivers MUST ignore
 * unknown frame `t` values and unknown object fields.
 *
 * A client advertises the version it speaks via the `v` field on its `sub`
 * frame; a server that cannot serve that version replies
 * `{ t: 'error', code: 'unsupported_protocol', fatal: true }`.
 */
export const LIVE_PROTOCOL = 1;
