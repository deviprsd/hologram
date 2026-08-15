# snabbdom (vendored)

Version 3.6.4, MIT licensed - see LICENSE. Copied verbatim from the npm package's `build`
directory, which is the compiled ESM the package publishes.

The `.js.map` and `.d.ts` files are dropped. The source maps point at `../src/*.ts`, which the
package does not ship, so every one of them is broken, and nothing here reads the type
declarations. The `.js` files are untouched.

## Why it is vendored

Historically, Hologram rendered template blocks as fragment vnodes (snabbdom's `experimental:
{fragments: true}`), which needed two local patches to diff correctly - both dropped once
per-element keys (dom.ex's `add_slot_keys/2`) replaced fragment-wrapped blocks entirely, so
neither the fragments flag nor either patch is in use anymore. The copy is byte-identical to
upstream as of that change; nothing below currently deviates.

Kept vendored rather than switched to an npm dependency for now, since that's a separate decision
with its own blast radius (package.json, lockfile, every `./vendor/snabbdom/...` import path) -
worth doing at some point, just not bundled into the migration that removed the reason to vendor
in the first place.

## Keeping it byte-identical

`assets/js/vendor/` is listed in the repository's `.prettierignore`. Without that, the formatter
reaches this directory through the `assets/js/**` glob in the `format.js` alias, reindents every
file, and a diff against upstream becomes unreadable.

## Deviations from upstream

None currently. Historical deviations (both since reverted - see git history for `build/init.js`
and `build/htmldomapi.js`) were marked with a `HOLOGRAM PATCH` comment in the source; use the same
convention if a new one is ever needed.

## Updating

Replace `build/` and `LICENSE` with the new release verbatim, delete the `.js.map` and `.d.ts`
files, and commit that as one step.
