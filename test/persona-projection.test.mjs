import test from 'node:test'
import assert from 'node:assert/strict'
import { projectConversationPrompt, discoveredToolProtocol } from '../lib/character/prompt-projection.js'

const section = (name, text) => ({name, text, order: 0})
const fixture = () => ({sections: [
  section('harness:identity', 'You are an AI agent powered by DeepSeek Harness.'),
  section('deployment:persona-prefix', 'You are a coding agent powered by the gpt-6.1-sol model.'),
  section('partner-identity', 'CURRENT ROLE'),
  section('tool:write', 'Read before overwriting.'),
  section('tool:jobs', 'Collect your background jobs.'),
  section('tool:unknown', 'Keep unknown plugin instruction.'),
  section('security:approval', 'Ask when the host requires approval.'),
  section('ui:deliverable-file-references', 'Use Markdown images for Web.'),
], tools: [{name:'partner_tools',parameters:{type:'object'}}], contexts: [{name:'memory',text:'Keep real history.'}], variables:{}})

test('chat projection replaces only stock identity and defers known tool guidance without changing tools or memory',()=>{
  const a=fixture(),before=structuredClone(a),agent={}
  const result=projectConversationPrompt(a,agent,{roleEnabled:true,discovery:true})
  assert.deepEqual(a,before,'input must remain immutable')
  assert.equal(result.tools,a.tools);assert.equal(result.contexts,a.contexts)
  assert.deepEqual(result.sections.map(s=>s.name),['harness:identity','partner-identity','tool:unknown','security:approval'])
  assert.equal(discoveredToolProtocol(agent,'write'),'Read before overwriting.')
  assert.equal(discoveredToolProtocol(agent,'job_output'),'Collect your background jobs.')
  assert.equal(discoveredToolProtocol(agent,'job_kill'),'Collect your background jobs.')
  assert.equal(discoveredToolProtocol({},'write'),undefined,'no cross-agent protocol')
})

test('custom preset identity and disabled role are preserved; native visible tools keep their guidance',()=>{
  const a=fixture();a.sections[1].text+='\nUser custom instruction.'
  a.tools.push({name:'write',parameters:{type:'object'}})
  const agent={},r=projectConversationPrompt(a,agent,{roleEnabled:true,discovery:true})
  assert.ok(r.sections.includes(a.sections[1]));assert.ok(r.sections.includes(a.sections[3]))
  assert.equal(discoveredToolProtocol(agent,'write'),undefined)
  const off=projectConversationPrompt(a,agent,{roleEnabled:false,discovery:false})
  assert.deepEqual(off,a)
  assert.equal(discoveredToolProtocol(agent,'job_output'),undefined,'do not retain stale guidance')
})

test('tool guidance is refreshed rather than accumulated across assemblies',()=>{
 const agent={},a=fixture()
 projectConversationPrompt(a,agent,{roleEnabled:true,discovery:true})
 a.sections[3].text='Updated write policy.'
 projectConversationPrompt(a,agent,{roleEnabled:true,discovery:true})
 assert.equal(discoveredToolProtocol(agent,'write'),'Updated write policy.')
 a.sections=a.sections.filter(s=>s.name!=='tool:write')
 projectConversationPrompt(a,agent,{roleEnabled:true,discovery:true})
 assert.equal(discoveredToolProtocol(agent,'write'),undefined)
})
