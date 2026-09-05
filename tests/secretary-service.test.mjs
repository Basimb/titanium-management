import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { handleSecretaryEvent, migrateSecretary } from '../lib/secretary-service.ts';
import { emptySecretaryIntent, validateSecretaryIntent, inferSecretaryIntent, searchSecretaryWeb } from '../lib/secretary-intent.ts';
import { createSecretaryJobs } from '../lib/secretary-jobs.ts';

function fixture(t) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT UNIQUE,role TEXT,active INTEGER,pin_hash TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT,status TEXT,created_by TEXT,created_at INTEGER,rejection_reason TEXT,rejected_by TEXT,rejected_at INTEGER);
    CREATE TABLE tasks(id TEXT PRIMARY KEY,project_id TEXT REFERENCES projects(id),title TEXT,details TEXT,priority TEXT,status TEXT,owner TEXT,suggested_owner TEXT,started_at INTEGER,due_date TEXT,completed_at INTEGER,rejection_reason TEXT,created_at INTEGER,updated_at INTEGER,archived_at INTEGER,archived_by TEXT);
    CREATE TABLE comments(id INTEGER PRIMARY KEY,task_id TEXT REFERENCES tasks(id),author TEXT,body TEXT,created_at INTEGER);
    CREATE TABLE attachments(id TEXT PRIMARY KEY,task_id TEXT REFERENCES tasks(id),file_name TEXT,content_type TEXT,size INTEGER,object_key TEXT,uploaded_by TEXT,created_at INTEGER);
    CREATE TABLE audit_logs(id INTEGER PRIMARY KEY,actor_user_id TEXT,actor_name TEXT,action TEXT,entity_type TEXT,entity_id TEXT,details TEXT,created_at INTEGER);
    INSERT INTO users VALUES('basem','باسم','admin',1,NULL,1,1),('member','خالد','member',1,NULL,1,1),('other','شادي','member',1,NULL,1,1);
    INSERT INTO projects VALUES('p','مشروع تجريبي','active','باسم',1,NULL,NULL,NULL),('p2','مشروع ثان','active','باسم',1,NULL,NULL,NULL);
    INSERT INTO tasks VALUES('t','p','لوحة','تفاصيل تنفيذ','red','progress','خالد','خالد',1,'2026-01-01',NULL,NULL,1,1,NULL,NULL),
      ('private','p2','مهمة شادي الخاصة','تفاصيل سرية','yellow','progress','شادي','شادي',1,NULL,NULL,NULL,1,1,NULL,NULL);`);
  migrateSecretary(db);
  const config = { enabled:true, sharedKey:'ab'.repeat(32), contacts:[{userId:'basem',number:'12025550103'},{userId:'member',number:'12025550101'},{userId:'other',number:'12025550102'}],allowedGroupIds:['12345@g.us'] };
  let count = 0, now = 1788580000000;
  const event = (extra={}) => ({ messageId:`EVENT-${++count}`,senderNumber:'12025550101',groupId:null,text:'شو مهامي؟',receivedAt:now,responseMessageId:`REPLY-${count}`, ...extra });
  const run = (plan=emptySecretaryIntent('summary'),extra={},infer) => handleSecretaryEvent(db,event(extra),config,{ infer:infer || (async()=>plan),now:()=>now });
  return {db,config,event,run,get now(){return now;},tick:n=>{now+=n;}};
}
function command(action,fields={},taskId='t',projectId=null) { const p=emptySecretaryIntent('command');return {...p,action,taskId,projectId,fields:{...p.fields,...fields}}; }
const pending = db => db.prepare('SELECT * FROM secretary_pending').get();

test('secretary scoped friendly summary has direct link and no foreign data', async t=>{
 const f=fixture(t); const result=await f.run(); assert.equal(result.status,'summary'); assert.match(result.reply,/خالد/);assert.match(result.reply,/project=p&task=t/);assert.doesNotMatch(result.reply,/مهمة شادي|تفاصيل سرية/);
});
test('only authenticated exact phone and approved group can invoke model',async t=>{
 const f=fixture(t);let calls=0;for(const extra of[{senderNumber:'12025550999'},{groupId:'999@g.us'}]){const r=await f.run(undefined,extra,async()=>{calls++;throw Error();});assert.equal(r.status,'denied');}assert.equal(calls,0);
});
test('history isolated by actor/group and never contains phone table',async t=>{
 const f=fixture(t);await f.run();let seen;
 await f.run(undefined,{senderNumber:'12025550102',groupId:'12345@g.us'},async input=>{seen=input;return emptySecretaryIntent('help');});assert.equal(seen.history.length,0);assert.doesNotMatch(JSON.stringify(seen),/1202555010/);assert.ok(seen.tasks.every(x=>x.id==='private'));
});
test('comment uses shared engine, no implicit completion, receipt duplicate does not repeat',async t=>{
 const f=fixture(t);const e=f.event({messageId:'COMMENT',text:'حكيت مع المحامي ولسه بستنى الرد'});const plan=command('comment',{body:e.text});const deps={infer:async()=>plan,now:()=>f.now};
 const first=await handleSecretaryEvent(f.db,e,f.config,deps);assert.equal(first.status,'applied');assert.equal(f.db.prepare('SELECT status FROM tasks WHERE id=\'t\'').get().status,'progress');
 const second=await handleSecretaryEvent(f.db,e,f.config,{...deps,infer:async()=>{throw Error('must not infer');}});assert.equal(second.status,'duplicate');assert.equal(f.db.prepare('SELECT count(*) n FROM comments').get().n,1);
});
test('member completion waits for actor-bound confirmation; then only approval',async t=>{
 const f=fixture(t);const proposed=await f.run(command('submit'),{text:'خلصت اللوحة بالكامل'});assert.equal(proposed.status,'confirmation');assert.equal(f.db.prepare("SELECT status FROM tasks WHERE id='t'").get().status,'progress');
 const token=pending(f.db).token;
 await f.run(emptySecretaryIntent('clarify','شو المقصود؟'),{senderNumber:'12025550102',text:`موافق ${token}`});assert.equal(f.db.prepare("SELECT status FROM tasks WHERE id='t'").get().status,'progress');
 const confirmed=await f.run(undefined,{text:`موافق ${token}`});assert.equal(confirmed.status,'applied');assert.equal(f.db.prepare("SELECT status FROM tasks WHERE id='t'").get().status,'approval');assert.equal(f.db.prepare("SELECT completed_at FROM tasks WHERE id='t'").get().completed_at,null);
 const audit=JSON.parse(f.db.prepare("SELECT details FROM audit_logs WHERE action='submit'").get().details);assert.equal(audit.auditContext.confirmedBy,'member');assert.equal(audit.auditContext.originalText,'خلصت اللوحة بالكامل');
});
test('cancellation and expired confirmation never mutate',async t=>{
 const f=fixture(t);await f.run(command('submit'),{text:'خلصت اللوحة'});assert.equal((await f.run(undefined,{text:'إلغاء'})).status,'cancelled');assert.equal(pending(f.db),undefined);
 await f.run(command('submit'),{text:'خلصت اللوحة'});const token=pending(f.db).token;f.tick(600001);assert.equal((await f.run(undefined,{text:`موافق ${token}`})).status,'stale');assert.equal(f.db.prepare("SELECT status FROM tasks WHERE id='t'").get().status,'progress');
});
test('task changes before confirmation invalidate exact proposal',async t=>{
 const f=fixture(t);await f.run(command('submit'),{text:'خلصت اللوحة'});const token=pending(f.db).token;f.db.exec("UPDATE tasks SET updated_at=2 WHERE id='t'");assert.equal((await f.run(undefined,{text:`موافق ${token}`})).status,'stale');
});
test('permissions changed while awaiting model prevent mutation',async t=>{
 const f=fixture(t);const r=await f.run(command('comment',{body:'update'}),{},async()=>{f.db.exec("UPDATE users SET active=0 WHERE id='member'");return command('comment',{body:'update'});});assert.equal(r.status,'denied');assert.equal(f.db.prepare('SELECT count(*) n FROM comments').get().n,0);
});
test('forged model task ID and member admin action cannot write',async t=>{
 const f=fixture(t);assert.equal((await f.run(command('delete_task'),{text:'احذف المهمة'})).status,'denied');assert.equal(pending(f.db),undefined);
 assert.equal((await f.run(command('comment',{body:'hack'},'private'))).status,'clarify');assert.equal(f.db.prepare('SELECT count(*) n FROM comments').get().n,0);
});
test('manager create task and project use real authorized IDs; delete needs confirmation',async t=>{
 const f=fixture(t);const e={senderNumber:'12025550103',text:'افتح مشروع تجريبي جديد'};
 assert.equal((await f.run(command('add_project',{name:'مشروع جديد'},null),e)).status,'applied');
 assert.equal((await f.run(command('add_task',{title:'مهمة جديدة',ownerId:'member'},null,'p'),{...e,text:'ضيف مهمة جديدة لخالد'})).status,'applied');
 assert.equal((await f.run(command('delete_task',{},'private'),{...e,text:'احذف مهمة شادي'})).status,'confirmation');assert.ok(f.db.prepare("SELECT id FROM tasks WHERE id='private'").get());
});
test('reused message ID changed body fails closed and cannot expose remapped replies',async t=>{
 const f=fixture(t);const e=f.event();await handleSecretaryEvent(f.db,e,f.config,{infer:async()=>emptySecretaryIntent('summary')});
 assert.equal((await handleSecretaryEvent(f.db,{...e,text:'something else'},f.config,{infer:async()=>{throw Error();}})).status,'denied');
 f.db.exec("UPDATE tasks SET owner='شادي',suggested_owner='شادي' WHERE id='t'");assert.equal((await handleSecretaryEvent(f.db,e,f.config,{infer:async()=>{throw Error();}})).status,'denied');
});
test('quoted reply cannot borrow another actor context or older confirmation',async t=>{
 const f=fixture(t);await f.run(command('submit'),{text:'خلصت اللوحة',responseMessageId:'BOT-PROPOSAL'});
 const token=pending(f.db).token;const r=await f.run(undefined,{text:`موافق ${token}`,replyToMessageId:'NONEXISTENT'});assert.equal(r.status,'clarify');
 const good=await f.run(undefined,{text:'نعم',replyToMessageId:'BOT-PROPOSAL'});assert.equal(good.status,'applied');
});
test('receipt failure rolls back management write and audit',async t=>{
 const f=fixture(t);f.db.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON secretary_events BEGIN SELECT RAISE(ABORT,'synthetic'); END;");
 await assert.rejects(f.run(command('comment',{body:'update'})));assert.equal(f.db.prepare('SELECT count(*) n FROM comments').get().n,0);assert.equal(f.db.prepare('SELECT count(*) n FROM audit_logs').get().n,0);
});
test('model inputs contain only catalog titles/status/IDs, not task details or login data',async t=>{
 const f=fixture(t);await f.run(undefined,{},async input=>{assert.doesNotMatch(JSON.stringify(input),/تفاصيل تنفيذ|pin_hash|senderNumber|sharedKey/);return emptySecretaryIntent('help');});
});
test('partial and future completion are not submit',()=>{
 for(const text of['ما خلصت اللوحة','لسه ناقص شيء','بكرا بخلص','half done?']){const input={text,tasks:[{id:'t',title:'لوحة',projectId:'p',status:'progress'}],projects:[],users:[],actor:{id:'member',name:'خالد',role:'member'},history:[],now:new Date().toISOString()};assert.equal(validateSecretaryIntent(command('submit'),input).kind,'clarify');}
});
test('explicit reminder is durable, sent once and not sent for completed work',async t=>{
 const f=fixture(t);let p=emptySecretaryIntent('remind');p.taskId='t';p.fields.remindAt=new Date(f.now+120000).toISOString();assert.equal((await f.run(p,{text:'ذكرني باللوحة بعد دقيقتين'})).status,'scheduled');f.tick(120001);
 const worker=createSecretaryJobs({db:f.db,config:f.config,now:()=>f.now});let sent=0;assert.equal((await worker.deliverNext(async message=>{sent++;assert.equal(message.to,'12025550101@s.whatsapp.net');assert.match(message.text,/اللوحة|لوحة/);})).status,'sent');assert.equal((await worker.deliverNext(async()=>sent++)).status,'idle');assert.equal(sent,1);
 p.fields.remindAt=new Date(f.now+120000).toISOString();await f.run(p);f.tick(120001);f.db.exec("UPDATE tasks SET status='completed' WHERE id='t'");assert.equal((await worker.deliverNext(async()=>sent++)).status,'failed');assert.equal(sent,1);
});
test('provider search never receives catalog or history and requires actual web tool evidence',async()=>{
 let body;const reply=await searchSecretaryWeb('LG televisions Jordan',{apiKey:'synthetic',fetcher:async(url,options)=>{body=JSON.parse(options.body);return Response.json({choices:[{message:{content:'نتيجة https://example.com/product',executed_tools:[]}}]});}});
 assert.equal(body.model,'groq/compound-mini');assert.deepEqual(body.compound_custom.tools.enabled_tools,['web_search']);assert.doesNotMatch(JSON.stringify(body),/taskCatalog|senderNumber|contacts/);assert.match(reply,/ما قدرت أتحقق/);
});
test('planner response limits reject tool calls and success cannot come from model JSON',async()=>{
 const input={text:'مرحبا',tasks:[],projects:[],users:[],actor:{id:'member',name:'خالد',role:'member'},history:[],now:new Date().toISOString()};
 await assert.rejects(inferSecretaryIntent(input,{apiKey:'synthetic',fetcher:async()=>Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(emptySecretaryIntent('help')),tool_calls:[{}]}}]})}));
});

test('voice create/comment/reminder always require confirmation before any write',async t=>{
 const f=fixture(t);const result=await f.run(command('comment',{body:'تحديث صوتي'}),{text:'سجل تحديث صوتي',inputKind:'voice'});assert.equal(result.status,'confirmation');assert.equal(f.db.prepare('SELECT count(*) n FROM comments').get().n,0);
 assert.match(result.reply,/فهمت من الصوت/);await f.run(undefined,{text:'إلغاء'});
 const p=emptySecretaryIntent('remind');p.taskId='t';p.fields.remindAt=new Date(f.now+120000).toISOString();assert.equal((await f.run(p,{inputKind:'voice'})).status,'confirmation');assert.equal(f.db.prepare('SELECT count(*) n FROM secretary_reminders').get().n,0);
 assert.equal((await f.run(undefined,{text:`موافق ${pending(f.db).token}`})).status,'scheduled');
});

test('identical titles require a uniquely named project, literal ID, or server-bound focus',()=>{
 const input={text:'سجل تحديث للوحة',tasks:[{id:'task-one',title:'لوحة',projectId:'p',status:'progress'},{id:'task-two',title:'لوحة',projectId:'p2',status:'progress'}],projects:[{id:'p',name:'المشروع الأول',status:'active'},{id:'p2',name:'المشروع الثاني',status:'active'}],users:[],actor:{id:'member',name:'خالد',role:'member'},history:[],now:new Date().toISOString()};
 const plan=command('comment',{body:'تحديث'},'task-one');
 assert.equal(validateSecretaryIntent(plan,input).kind,'clarify');
 assert.equal(validateSecretaryIntent(plan,{...input,text:'سجل تحديث للوحة في المشروع الأول'}).kind,'command');
 assert.equal(validateSecretaryIntent(plan,{...input,focusedTaskId:'task-one'}).kind,'command');
 assert.equal(validateSecretaryIntent(plan,{...input,text:'سجل تحديث task-one'}).kind,'command');
 assert.equal(validateSecretaryIntent(plan,{...input,text:'سجل تحديث في المشروع الأول',tasks:input.tasks.map(t=>({...t,projectId:'p'}))}).kind,'clarify');
});

test('freeform replies and history lose visibility when input task permissions change',async t=>{
 const f=fixture(t);const event=f.event();
 await handleSecretaryEvent(f.db,event,f.config,{infer:async()=>emptySecretaryIntent('chat','تذكرت حديثك عن اللوحة'),now:()=>f.now});
 f.db.exec("UPDATE tasks SET owner='شادي',suggested_owner='شادي' WHERE id='t'");
 assert.equal((await handleSecretaryEvent(f.db,event,f.config,{infer:async()=>{throw Error('no repeated inference');},now:()=>f.now})).status,'denied');
 await f.run(undefined,{},async input=>{assert.equal(input.history.length,0);return emptySecretaryIntent('help');});
});

test('public search renders only source URLs actually returned by the search tool',async()=>{
 const reply=await searchSecretaryWeb('public product search',{apiKey:'synthetic',fetcher:async()=>Response.json({choices:[{message:{content:'Invented https://invented.example/',executed_tools:[{type:'web_search',search_results:{results:[{title:'Verified product',url:'https://example.com/product',content:'Source description'},{title:'Unsafe',url:'http://127.0.0.1/',content:'Discard'}]}}]}}]})});
 assert.match(reply,/https:\/\/example.com\/product/);assert.doesNotMatch(reply,/invented\.example|127\.0\.0\.1/);
});

test('late bare approval and old token/quote cannot execute a replacement request',async t=>{
 const f=fixture(t);const manager={senderNumber:'12025550103'};
 await f.run(command('edit_task',{title:'تعديل الطلب الأول'}),{...manager,text:'عدل عنوان اللوحة',responseMessageId:'PROPOSAL-A'});
 const firstToken=pending(f.db).token;
 await f.run(command('delete_task',{},'private'),{...manager,text:'احذف مهمة شادي',responseMessageId:'PROPOSAL-B'});
 const secondToken=pending(f.db).token;
 const noInference=async()=>{throw Error('confirmation attempts must never reach the model');};
 for(const extra of [{text:'نعم'},{text:`موافق ${firstToken}`},{text:'نعم',replyToMessageId:'PROPOSAL-A'},{text:`موافق ${secondToken}`,replyToMessageId:'PROPOSAL-A'}]) {
   const result=await f.run(undefined,{...manager,...extra},noInference);
   assert.equal(result.status,'clarify');assert.equal(pending(f.db).token,secondToken);
   assert.ok(f.db.prepare("SELECT id FROM tasks WHERE id='private'").get());
   assert.equal(f.db.prepare("SELECT title FROM tasks WHERE id='t'").get().title,'لوحة');
 }
 assert.equal(f.db.prepare("SELECT count(*) n FROM audit_logs WHERE action IN ('delete','edit')").get().n,0);
 const event=f.event({...manager,text:`موافق ${secondToken}`});
 assert.equal((await handleSecretaryEvent(f.db,event,f.config,{infer:noInference,now:()=>f.now})).status,'applied');
 assert.equal(f.db.prepare("SELECT id FROM tasks WHERE id='private'").get(),undefined);
 assert.equal((await handleSecretaryEvent(f.db,event,f.config,{infer:noInference,now:()=>f.now})).status,'duplicate');
 assert.equal(f.db.prepare("SELECT count(*) n FROM audit_logs WHERE action='delete'").get().n,1);
});

test('bare approval without a pending request cannot become a model-generated action',async t=>{
 const f=fixture(t);
 for(const text of ['نعم','موافق','تمام','موافق T123ABC']) {
   const result=await f.run(command('comment',{body:'must not be written'}),{text},async()=>{throw Error('do not infer approval');});
   assert.equal(result.status,'clarify');
 }
 assert.equal(f.db.prepare('SELECT count(*) n FROM comments').get().n,0);
});

test('duplicate project names require the selected literal ID in the current message',()=>{
 const input={text:'أضف مهمة إلى مشروع التجهيز',tasks:[{id:'task-one',title:'لوحة',projectId:'project-one',status:'progress'}],projects:[{id:'project-one',name:'مشروع التجهيز',status:'active'},{id:'project-two',name:'مَشروع التجهيز',status:'active'}],users:[],actor:{id:'basem',name:'باسم',role:'admin'},history:[{role:'user',content:'project-one'}],now:new Date().toISOString()};
 for(const plan of [command('add_task',{title:'تقرير جديد'},null,'project-one'),command('move_task',{},'task-one','project-one'),command('edit_project',{name:'اسم جديد'},null,'project-one'),command('delete_project',{},null,'project-one')]) {
   assert.equal(validateSecretaryIntent(plan,input).kind,'clarify');
   assert.equal(validateSecretaryIntent(plan,{...input,text:'نفذ في project-two'}).kind,'clarify');
   assert.equal(validateSecretaryIntent(plan,{...input,text:'نفذ في project-one-extra'}).kind,'clarify');
   assert.equal(validateSecretaryIntent(plan,{...input,text:'نفذ في project-one'}).kind,'command');
 }
});

test('ambiguous project creation produces clarification and never inserts into a guessed project',async t=>{
 const f=fixture(t);f.db.exec("UPDATE projects SET name='مشروع تجريبي' WHERE id='p2'");
 const manager={senderNumber:'12025550103'};const plan=command('add_task',{title:'تقرير جديد'},null,'p2');
 const before=f.db.prepare('SELECT count(*) n FROM tasks').get().n;
 assert.equal((await f.run(plan,{...manager,text:'أضف تقرير جديد إلى مشروع تجريبي'})).status,'clarify');
 assert.equal(f.db.prepare('SELECT count(*) n FROM tasks').get().n,before);
 assert.equal(pending(f.db),undefined);
 assert.equal((await f.run(plan,{...manager,text:'أضف تقرير جديد إلى p2'})).status,'applied');
 assert.equal(f.db.prepare("SELECT project_id FROM tasks WHERE title='تقرير جديد'").get().project_id,'p2');
});
