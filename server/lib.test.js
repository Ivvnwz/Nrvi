import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanModel, safeActions, buildMessages, DEFAULT_MODEL } from './lib.js';

test('cleanModel elimina comillas, backticks y espacios', () => {
  assert.equal(cleanModel('  "openai/gpt-oss-20b"  '), 'openai/gpt-oss-20b');
  assert.equal(cleanModel('`model`'), 'model');
  assert.equal(cleanModel('multi word'), 'multiword');
});

test('cleanModel usa el modelo por defecto si está vacío', () => {
  assert.equal(cleanModel(''), DEFAULT_MODEL);
  assert.equal(cleanModel(null), DEFAULT_MODEL);
});

test('safeActions conserva solo acciones permitidas y válidas', () => {
  const calls = [
    { function: { name: 'click_element', arguments: '{"id":"action-1"}' } },
    { function: { name: 'hack_system', arguments: '{"id":"action-2"}' } },
    { function: { name: 'fill_input', arguments: '{"id":"field-0","text":"hola"}' } },
    { function: { name: 'focus_field', arguments: 'no-json' } },
    { function: { name: 'scroll_page', arguments: '{"direction":"down"}' } }
  ];
  assert.deepEqual(safeActions(calls), [
    { type: 'click_element', id: 'action-1' },
    { type: 'fill_input', id: 'field-0', text: 'hola' },
    { type: 'scroll_page', direction: 'down' }
  ]);
});

test('safeActions tolera argumentos vacíos y entradas no-array', () => {
  assert.deepEqual(safeActions([{ function: { name: 'focus_field' } }]), [{ type: 'focus_field' }]);
  assert.deepEqual(safeActions(null), []);
  assert.deepEqual(safeActions(undefined), []);
});

test('safeActions descarta argumentos que son arrays o primitivos', () => {
  assert.deepEqual(safeActions([{ function: { name: 'click_element', arguments: '[1,2]' } }]), []);
  assert.deepEqual(safeActions([{ function: { name: 'click_element', arguments: '"x"' } }]), []);
});

test('buildMessages coloca el prompt, el historial válido y la pregunta', () => {
  const messages = buildMessages({
    systemPrompt: 'sys',
    history: [
      { role: 'user', content: 'hola' },
      { role: 'assistant', content: 'buenas' },
      { role: 'system', content: 'ignorar' },
      { role: 'user', content: 42 }
    ],
    context: { title: 'Inicio' },
    question: '  ¿dónde inicio sesión?  '
  });

  assert.equal(messages[0].role, 'system');
  assert.equal(messages[0].content, 'sys');
  assert.deepEqual(messages.slice(1, 3), [
    { role: 'user', content: 'hola' },
    { role: 'assistant', content: 'buenas' }
  ]);
  assert.match(messages.at(-1).content, /Inicio/);
  assert.match(messages.at(-1).content, /¿dónde inicio sesión\?/);
});

test('buildMessages recorta el historial a los últimos 10 mensajes', () => {
  const history = Array.from({ length: 25 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `m${index}` }));
  const messages = buildMessages({ systemPrompt: 'sys', history, context: {}, question: 'q' });
  assert.equal(messages.length, 1 + 10 + 1);
  assert.equal(messages[1].content, 'm15');
});

test('buildMessages usa contexto vacío si falta', () => {
  const messages = buildMessages({ systemPrompt: 'sys', question: 'q' });
  assert.match(messages.at(-1).content, /\{\}/);
});
