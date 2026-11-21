export const meta = {
  name: 'game-unit',
  description: 'One pushable step on the game: one worker builds it, one checker judges it in the running game, one repair round if needed',
  phases: [
    { title: 'Build', detail: 'one worker does the step' },
    { title: 'Check', detail: 'independent check in the running game', model: 'sonnet' },
    { title: 'Repair', detail: 'only if the check finds blockers: one repair round and a re-check' },
  ],
}

// args: { label, brief, task, files, checkFocus, builderModel?, blender? }
const A = args
const REPO = 'C:/Users/User/Documents/GitHub/GTA-Claude-4.8-Opus'

const WORKER_SCHEMA = {
  type: 'object',
  properties: {
    tsc_clean: { type: 'boolean' },
    boots_high: { type: 'boolean', description: 'game boots with errors [] at high' },
    boots_low: { type: 'boolean', description: 'game boots with errors [] with q=low' },
    pushable: { type: 'boolean', description: 'true only if you ran it and nothing looks or runs worse than before' },
    what_changed: { type: 'string', description: 'what you changed in this run and what a player will notice, plainly' },
    done: { type: 'array', items: { type: 'string' }, description: 'each part of the task that is finished, with how you confirmed it' },
    not_done: { type: 'array', items: { type: 'string' }, description: 'each part of the task that is unfinished or was not attempted, and why' },
    numbers: { type: 'string', description: 'measurements before and after, if the task asked for any' },
    problems: { type: 'array', items: { type: 'string' }, description: 'risks, things seen that are wrong, things the lead must know' },
    images: { type: 'array', items: { type: 'string' }, description: 'paths of the pictures that show the result, before and after where you have both' },
  },
  required: ['tsc_clean', 'boots_high', 'boots_low', 'pushable', 'what_changed', 'done', 'not_done', 'problems', 'images'],
}

const CHECK_SCHEMA = {
  type: 'object',
  properties: {
    tsc_clean: { type: 'boolean' },
    errors_high: { type: 'array', items: { type: 'string' } },
    errors_low: { type: 'array', items: { type: 'string' } },
    errors_mobile: { type: 'array', items: { type: 'string' } },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          what: { type: 'string' },
          verdict: { type: 'string', enum: ['good', 'no_change_seen', 'cosmetic', 'blocker', 'could_not_see'] },
          picture: { type: 'string' },
        },
        required: ['what', 'verdict'],
      },
    },
    blockers: { type: 'array', items: { type: 'string' }, description: 'things that must be fixed before this goes live, each with the picture that shows it' },
    improved: { type: 'boolean', description: 'true if a player would see or feel the improvement the worker claims' },
    numbers: { type: 'string' },
    pushable: { type: 'boolean' },
    images: { type: 'array', items: { type: 'string' } },
  },
  required: ['tsc_clean', 'errors_high', 'errors_low', 'findings', 'blockers', 'improved', 'pushable', 'images'],
}

const rules = `Rules for this run, on top of the brief: nobody else is editing the tree. Your files are: ${A.files}. Touch nothing else. ${A.blender ? 'Blender runs only with its window showing (never --background or -b) and after the battery check, exactly as the brief file tools/briefs/allout-cars-2.md describes under "Rules for this restart"; make sure no Blender window is left open at the end.' : 'This task needs no Blender; do not run it.'} Stay inside the limits in tools/briefs/common.md (about 60 tool calls, about 14 pictures). Do only the task below and stop. Leave the tree type-checking and the game booting at every pause. Never claim something was verified unless you ran it or looked at it.`

const workerPrompt = `You are working on the browser game in ${REPO} (Windows). Read ${REPO}/tools/briefs/common.md, then ${REPO}/${A.brief}, and what they point to. ${rules}

YOUR TASK IN THIS RUN
${A.task}

Finish with npx tsc --noEmit clean and the game booting with "errors": [] at high and with q=low.`

const checkPrompt = (changed) => `You are an independent checker for the browser game in ${REPO} (Windows). Read ${REPO}/tools/briefs/common.md for how to boot the game, take screenshots and judge them (its "Checking in the real game" section). You change NOTHING under src/, tools/ or public/. You may write your own scripts under scratch/check/ and pictures under shots/check/. No git commands that change state, no npm install, no npm run build, no Blender. About 40 tool calls and at most 14 pictures.

A worker has just changed these files: ${A.files}. The lead will push the tree to the live site if you say it is sound. What the worker says it did (do not take its word for anything; look): ${changed}

Always: npx tsc --noEmit must be clean; the game must boot with an empty errors list at high, with q=low, and with the phone layout (tools/shot.mjs --mobile). Models load a few seconds after boot, so wait real time before any picture. \`git diff --stat\` shows what differs from the live site, and \`git stash\` is NOT allowed; to see the live version of something, look at https://gta.doofus.live is not possible from the harness, so judge the current tree on its own merits and against any "before" pictures the worker names.

What to look at for this step:
${A.checkFocus}

A blocker is breakage a player would see, an error, or something clearly worse than before. An imperfection that is only cosmetic gets the verdict cosmetic. If you could not see something well enough to judge, say could_not_see and do not guess. "improved" is your honest answer to whether a player would notice the improvement claimed. pushable is true only with tsc clean, no errors and no blockers; if unsure whether something is breakage, treat it as a blocker and name the picture.`

phase('Build')
const worker = await agent(workerPrompt, { label: `build: ${A.label}`, phase: 'Build', schema: WORKER_SCHEMA, ...(A.builderModel ? { model: A.builderModel } : {}) })
if (!worker) {
  log('The worker died before reporting (usage limit or error). Nothing was checked.')
  return { dead: 'worker' }
}
log(`Worker: pushable=${worker.pushable}, done=${worker.done.length}, not done=${worker.not_done.length}`)

phase('Check')
let check = await agent(checkPrompt(worker.what_changed), { label: `check: ${A.label}`, phase: 'Check', schema: CHECK_SCHEMA, model: 'sonnet' })
if (!check) {
  log('The checker died before reporting.')
  return { worker, dead: 'checker' }
}
log(`Check: pushable=${check.pushable}, improved=${check.improved}, blockers=${check.blockers.length}`)

let repair = null
if (!check.pushable && check.blockers.length) {
  phase('Repair')
  const first = check
  repair = await agent(`You are working on the browser game in ${REPO} (Windows). Read ${REPO}/tools/briefs/common.md, then ${REPO}/${A.brief}. ${rules}

YOUR TASK IN THIS RUN
An earlier worker did this: ${worker.what_changed}

An independent checker then found these blockers in the running game:
${first.blockers.map((b, i) => `${i + 1}. ${b}`).join('\n')}

Fix exactly those, each confirmed in the game with a picture. If one cannot be fixed inside your limits, put the affected files back to the last state that worked (\`git diff\` shows what changed since the live site; \`git checkout -- <file>\` is allowed for your own files only) and say so.

Finish with npx tsc --noEmit clean and the game booting with "errors": [] at high and with q=low.`,
    { label: `repair: ${A.label}`, phase: 'Repair', schema: WORKER_SCHEMA, ...(A.builderModel ? { model: A.builderModel } : {}) })
  if (repair) {
    const again = await agent(checkPrompt(repair.what_changed) + `\n\nAn earlier check found these blockers, which a worker says are now fixed; look at each of them first:\n${first.blockers.join('\n')}`,
      { label: `re-check: ${A.label}`, phase: 'Repair', schema: CHECK_SCHEMA, model: 'sonnet' })
    if (again) check = again
  }
}

return { worker, repair, check }
