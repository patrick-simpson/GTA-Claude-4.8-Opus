# next/

Modules for later milestones (sound, missions, effects, menus, post-processing),
written ahead of time against the contracts in `src/core/api.ts` while milestone 1
is still being built. Nothing in `src/` imports anything here, so none of it is
in the game or the build yet. Each one moves into `src/` and gets wired into
`Game` when its milestone comes up (see PLAN.md).

Type-check: `npx tsc --noEmit -p next/tsconfig.json`
