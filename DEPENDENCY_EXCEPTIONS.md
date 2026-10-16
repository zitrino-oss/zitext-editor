# Dependency security exceptions

Owner: ZITEXT security maintainers  
Last reviewed: 2026-10-07  
Next review: 2027-01-07

The application has no ignored runtime advisory that is directly actionable in
its own dependency declarations. The remaining exceptions are upstream-bound:

- `RUSTSEC-2026-0097`: the only affected copy left is `rand 0.7.3`, a
  build-time dependency (`selectors` → `phf_codegen` → `phf_generator`) of
  Tauri's HTML parser. The patched `rand 0.8.6` is also compile-time only
  (through `phf_macros`); the only `rand` in the shipped app is the patched
  0.10.
  ZITEXT does not call the affected custom-logger API. (Rechecked 2026-10-07.)
- `RUSTSEC-2026-0194` and `RUSTSEC-2026-0195`: `quick-xml 0.39` is used only by
  `wayland-scanner` at build time on first-party Wayland protocol XML. Runtime
  XML handling uses the patched dependency line.
- `RUSTSEC-2024-0429`: `glib 0.18.5` is constrained by Tauri's Linux GTK3 stack.
  ZITEXT does not use `VariantStrIter`; moving to `glib >=0.20` requires an
  upstream Tauri/GTK migration and is tracked for each quarterly review.

RustSec also reports unmaintained-only warnings for the transitive GTK3 family,
`fxhash`, `proc-macro-error`, and the `unic-*` crates. They arrive through the
current Tauri/WebKit/url-pattern stack, have no known vulnerability attached to
those warnings, and cannot be replaced from ZITEXT's direct dependency list.
They remain part of the same quarterly upstream-migration review.

`anyhow` was updated to 1.0.103, which removes `RUSTSEC-2026-0190` from the
locked graph. CI continues to run `cargo audit` so upstream changes are visible.

2026-10-07: `event-listener` was updated to 5.4.2 (`RUSTSEC-2026-0221`,
unsound `StackSlot`), and the yanked `chacha20 0.10.1` was replaced by 0.10.2.
`cargo audit` then reports no vulnerabilities and only the allowed
unmaintained warnings above. The owners reviewed and accepted the four
exceptions above on 2026-10-07; next review 2027-01-07.
