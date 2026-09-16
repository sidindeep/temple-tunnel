const test = require('node:test');
const assert = require('node:assert/strict');
const {createConnectionNotices} = require('../src/connection-notices');
function fixture() {
  const messages=[];
  return {messages, notices:createConnectionNotices((title,body)=>messages.push({title,body}))};
}
test('one loss notice per incident and one recovery notice',()=>{
  const {messages,notices}=fixture();
  notices.connected('A');notices.lost();notices.lost();notices.connected('B');
  assert.equal(messages.length,2);
  assert.equal(messages[0].title,'Соединение VPN потеряно');
  assert.match(messages[1].body,/B/);
  notices.lost();assert.equal(messages.length,3);
});
test('manual stop and initial connection failures do not report an outage',()=>{
  const {messages,notices}=fixture();
  notices.lost();notices.failed();notices.connected('A');notices.cancel();notices.lost();notices.failed();
  assert.equal(messages.length,0);
});
test('exhausted recovery only reports failure once',()=>{
  const {messages,notices}=fixture();
  notices.connected('A');notices.lost();notices.failed();notices.failed();
  assert.equal(messages.length,2);assert.equal(messages[1].title,'Не удалось восстановить VPN');
});
test('manual cancellation suppresses late recovery notices',()=>{
  const {messages,notices}=fixture();
  notices.connected('A');notices.lost();notices.cancel();notices.connected('B');
  assert.equal(messages.length,1);
});
