import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAgentQuestion, TelegramQuestions } from '../dist/services/telegram-questions.js';

const q = { question: '시간 진행 방식을 선택해 주세요.', options: ['턴제', '실시간', '혼합'] };
test('only an explicit validated question is actionable', () => {
  assert.deepEqual(parseAgentQuestion('header\nTELEGRAM_QUESTION: '+JSON.stringify(q)), q);
  assert.equal(parseAgentQuestion('턴제·실시간·혼합 중 선택해 주세요.'), undefined);
  for(const value of [null, {}, { ...q, options: ['하나'] }, { ...q, options: ['a','a'] }, { ...q, options: [1,2] }]) {
    assert.equal(parseAgentQuestion('TELEGRAM_QUESTION: '+JSON.stringify(value)), undefined);
  }
  assert.equal(parseAgentQuestion('TELEGRAM_QUESTION: not json'), undefined);
});
test('buttons bind to bot, chat and session; consumed exactly once', () => {
  const s=new TelegramQuestions(), pending=s.create('bot','chat','S1',q);
  assert.equal(s.take(pending.id,'other','chat','S1',0),undefined);
  assert.equal(s.take(pending.id,'bot','other','S1',0),undefined);
  assert.equal(s.take(pending.id,'bot','chat','S2',0),undefined);
  assert.equal(s.take(pending.id,'bot','chat','S1',9),undefined);
  assert.equal(s.take(pending.id,'bot','chat','S1',0)?.options[0],'턴제');
  assert.equal(s.take(pending.id,'bot','chat','S1',0),undefined);
});
test('Other, free text, replacement and expiry', () => {
  let now=0; const s=new TelegramQuestions(()=>now);
  let pending=s.create('bot','chat','S1',q);
  assert.ok(s.take(pending.id,'bot','chat','S1',q.options.length));
  pending=s.create('bot','chat','S1',q); s.clear('bot','chat');
  assert.equal(s.take(pending.id,'bot','chat','S1',0),undefined);
  pending=s.create('bot','chat','S1',q); s.create('bot','chat','S1',q);
  assert.equal(s.take(pending.id,'bot','chat','S1',0),undefined);
  pending=s.create('bot','chat','S1',q); now+=6*60*60*1000+1;
  assert.equal(s.take(pending.id,'bot','chat','S1',0),undefined);
});
