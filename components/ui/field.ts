/**
 * The one input style.
 *
 * This was copy-pasted as a module-local `const field` in nine components, in
 * two near-identical variants — which meant any change to how an input looks
 * had to be made nine times or made inconsistently. It was hoisted when the
 * type scale changed for phones, because that change would otherwise have been
 * the tenth place to get it slightly wrong.
 *
 * `disabled:opacity-50` is here for everyone, not only the components that
 * previously carried it: it does nothing until an input is actually disabled,
 * and a disabled field that looks enabled is a worse inconsistency than an
 * unused utility class.
 */
export const FIELD =
  'px-3 py-2 bg-surface border border-line rounded-field text-ink text-sm ' +
  'focus:border-accent focus:outline-none disabled:opacity-50'

/** The same, stretched to its container — what nearly every form wants. */
export const FIELD_FULL = `w-full ${FIELD}`
