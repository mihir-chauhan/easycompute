---
description: Conventions for the EasyCompute package (generated code-first by c3app-gen)
alwaysApply: false
---

# EasyCompute — package conventions

This package was generated in the C3 Code `blankPkg` layout. Read `src/WORKSPACE_SUMMARY.md` first. When you change it,
keep these conventions so the generated files and your edits stay consistent:

- One type per file in `src/`; enums and result types are nested (`<Type>.<Enum>.c3typ`, `<Type>.DashboardSummary.c3typ`).
  Every type, field, enum value and method has a multi-line `/** */` doc.
- Display names use the inherited `name` field where the summary says so; never declare `name`, `type` or `version`.
- Sample rows are in `data/<Type>/<Type>.json` (explicit ids, references as `{ "id": ... }`). Upsert with
  `C3.pkg().upsertAllSeed(true)` after changing them.
- UI: every backend call is `c3Call` from `@/c3Action`; pages render inside `components/PageFrame`; badge colors come
  from the `*_APPEARANCE` maps in `lib/format.ts`; chart colors from `chartColor()` there. Do not hard-code colors.
- Keep `npm run build` green (lint + tsc + vite).
