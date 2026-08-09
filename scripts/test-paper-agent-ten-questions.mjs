import test from 'node:test'
import assert from 'node:assert/strict'
import {
  TEN_QUESTION_IDS,
  buildInitialAnswerPrompt,
  buildReanswerPrompt,
  isReanswerCurrent,
} from '../src/services/paperAgentTenQuestions.ts'

test('uses stable q1-q10 identities independent of translated question copy', () => {
  assert.deepEqual(TEN_QUESTION_IDS, ['q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7', 'q8', 'q9', 'q10'])
  assert.match(buildInitialAnswerPrompt('q10'), /Q10/)
  assert.match(buildInitialAnswerPrompt('q10'), /paper\.txt/)
})

test('re-answer prompt includes the exact committed human revision and keeps fields separate', () => {
  const question = {
    id: 'q1',
    aiInitial: {
      text: 'immutable first answer', engine: 'pi', turnId: 't1', contextRevision: 'c1',
      humanRevision: 0, humanEditRevision: 0, completedAtMs: 1, stale: false,
    },
    humanDraft: 'draft changed later',
    humanEditRevision: 3,
    humanCommitted: 'exact committed human answer',
    humanCommittedRevision: 2,
    aiReanswer: null,
    pending: null,
  }
  const prompt = buildReanswerPrompt(question)
  assert.match(prompt, /immutable first answer/)
  assert.match(prompt, /exact committed human answer/)
  assert.match(prompt, /修订 2/)
  assert.doesNotMatch(prompt, /draft changed later/)
})

test('re-answer provenance must match both committed and edit revisions', () => {
  const question = {
    id: 'q2', aiInitial: null, humanDraft: 'x', humanEditRevision: 4,
    humanCommitted: 'x', humanCommittedRevision: 2, pending: null,
    aiReanswer: {
      text: 'answer', engine: 'codex', turnId: 't2', contextRevision: 'c2',
      humanRevision: 2, humanEditRevision: 4, completedAtMs: 2, stale: false,
    },
  }
  assert.equal(isReanswerCurrent(question), true)
  question.humanEditRevision = 5
  assert.equal(isReanswerCurrent(question), false)
})
