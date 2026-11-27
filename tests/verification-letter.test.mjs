import test from 'node:test';
import assert from 'node:assert/strict';
import {verificationLetter} from '../server/email.mjs';

test('both mail alternatives keep leading zeroes, expiry and a copyable code',()=>{
  const code='003749';
  const mail=verificationLetter(code);
  assert.ok(!mail.subject.includes(code));
  for(const body of [mail.text,mail.html]){
    assert.equal(body.split(code).length,2);
    assert.match(body,/10 分钟内有效/);
    assert.match(body,/请勿转发/);
  }
  assert.ok(mail.html.includes('>'+code+'</p>'));
  const [stamp]=mail.attachments;
  assert.ok(mail.html.includes('src="cid:'+stamp.content_id+'"'));
  assert.equal(Buffer.from(stamp.content,'base64').subarray(1,4).toString(),'PNG');
});
