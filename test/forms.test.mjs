import test from 'node:test';
import assert from 'node:assert/strict';
import { presentForm, validateAnswer } from '../native-forms.mjs';

test('common question fields remain explicit and typed',()=>{
  const form={id:'frm_test',title:'选择方案',fields:[{key:'choice',type:'string',options:[{value:'a',label:'方案 A'}],required:true},{key:'confirm',type:'boolean'},{key:'count',type:'integer'},{key:'many',type:'multiselect',options:[{value:'a',label:'A'}],custom:true}]};
  assert.equal(presentForm(form).requiresDesktop,false);
  assert.equal(validateAnswer(form,{choice:'a',confirm:false,count:2,many:['a','其他']}).count,2);
  assert.throws(()=>validateAnswer(form,{unknown:'x'}),/未知字段/);
  assert.throws(()=>validateAnswer(form,{count:2.5}),/数字/);
});
test('hidden or external/conditional fields are not exposed or auto-answered',()=>{
  const form={id:'frm_secret',title:'授权',fields:[{key:'secret',type:'string',hidden:true,default:'DO_NOT_EXPOSE'}]};
  const shown=presentForm(form);
  assert.equal(shown.requiresDesktop,true);
  assert.equal(JSON.stringify(shown).includes('DO_NOT_EXPOSE'),false);
  assert.throws(()=>validateAnswer(form,{secret:'anything'}),/桌面端/);
  assert.equal(presentForm({id:'frm_link',fields:[{key:'auth',type:'external',url:'https://example.com/?token=secret'}]}).requiresDesktop,true);
});
