import test from 'node:test';
import assert from 'node:assert/strict';
import { renderResearchResult } from '../jester-extension/src/popup/research-result.js';

function documentFixture() {
  const document = {createElement(tag) { return {tag,ownerDocument:document,children:[],
    append(...nodes) { this.children.push(...nodes); },replaceChildren(...nodes) { this.children = nodes; },
    set innerHTML(_) { throw new Error('Research content must never become HTML'); }
  }; }};
  return {document,card:document.createElement('details')};
}

test('the popup preserves a full research answer and renders only safe clickable source URLs', () => {
  const {card,document} = documentFixture();
  const answer = 'A detailed research finding.\n'.repeat(180);
  renderResearchResult(card,{text:answer,sources:[
    {url:'https://school.instructure.com/courses/1',title:'Canvas course',fetchedAt:'2026-11-16T20:00:00Z'},
    {url:'javascript:alert(1)',title:'Unsafe link'},
    {url:'file:///private/file',title:'Local file'},
    {url:'https://user:password@example.com/',title:'Credentials'}
  ]},document);
  assert.equal(card.hidden,false);
  assert.equal(card.children[0].textContent,'Research results');
  assert.equal(card.children[1].textContent,answer);
  const sources = card.children[2];
  assert.equal(sources.children.length,1);
  const [link,address,stamp] = sources.children[0].children;
  assert.equal(link.tag,'a');
  assert.equal(link.href,'https://school.instructure.com/courses/1');
  assert.equal(link.target,'_blank');
  assert.equal(link.rel,'noopener noreferrer');
  assert.equal(address.textContent,link.href);
  assert.match(stamp.textContent,/2026-11-16T20:00:00Z/);
});

test('scraped markup stays literal text, rendering is bounded, and missing results stay hidden', () => {
  const {card,document} = documentFixture();
  const markup = '<img src=x onerror="alert(1)">';
  renderResearchResult(card,{text:markup,sources:[{url:'https://example.com/',title:markup}]},document);
  assert.equal(card.children[1].textContent,markup);
  assert.equal(card.children[2].children[0].children[0].textContent,markup);
  renderResearchResult(card,{text:'x'.repeat(30000),sources:Array.from({length:30},(_,i) => ({url:`https://example.com/${i}`}))},document);
  assert.equal(card.children[1].textContent.length,16000);
  assert.equal(card.children[2].children.length,8);
  renderResearchResult(card,null,document);
  assert.equal(card.hidden,true);
  assert.equal(card.children.length,0);
});
