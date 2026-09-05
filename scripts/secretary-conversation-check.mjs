// One synthetic conversational check per invocation; no database or WhatsApp send.
// Requires the existing private TITANIUM_TEAM_CHAT_CONFIG, never prints credentials.
import { readTeamChatSettings } from '../lib/team-chat-settings.ts';
import { inferSecretaryIntent } from '../lib/secretary-intent.ts';

const base = { actor:{id:'basem',name:'مستخدم تجريبي',role:'admin'},
  tasks:[{id:'synthetic-report',title:'التقرير التجريبي',projectId:'synthetic-project',status:'progress'}],
  projects:[{id:'synthetic-project',name:'مشروع الاختبار',status:'active'}], users:[], history:[],
  focusedTaskId:null, now:'2026-09-05T09:00:00.000Z' };
const cases = [
  { text:'هلا كيفك، بدي تحكي معي طبيعي مش قائمة أوامر', kinds:['chat'] },
  { text:'مش فاهم وضحلي بمثال بسيط', kinds:['chat'], history:[
    {role:'user',content:'كيف أرتب شغلي؟'},
    {role:'assistant',content:'اختَر المهمة الأكثر أهمية وقسّمها لخطوة صغيرة تبدأ فيها اليوم.'}] },
  { text:'شو رأيك أغير موعدها؟', kinds:['chat','clarify'], focusedTaskId:'synthetic-report', history:[
    {role:'user',content:'خلينا نحكي عن التقرير التجريبي'},
    {role:'assistant',content:'أكيد، شو حاب تناقش بخصوص التقرير؟'}] },
  { text:'كيف بقدر أحذف التقرير التجريبي؟', kinds:['chat','help','clarify'] },
  { text:'لا قصدي لسه ما خلصت التقرير التجريبي، ناقص رد المورد', kinds:['command','clarify'], action:'comment' },
  { text:'مين مسؤول عن التقرير التجريبي وشو آخر تحديث؟', kinds:['details'], taskId:'synthetic-report' },
  { text:'ابعث للتيم كل واحد لحاله على الخاص: بكرا الاجتماع الساعة 10', kinds:['message_team'],
    canMessageTeam:true, messageRecipients:[{id:'synthetic-one',name:'الموظف الأول'},{id:'synthetic-two',name:'الموظف الثاني'}],
    expectedRecipients:['all-team'], expectedBody:'بكرا الاجتماع الساعة 10' },
  { text:'ارسل للموظف الأول فقط على الخاص: أهلا وسهلا', kinds:['message_team'],
    canMessageTeam:true, messageRecipients:[{id:'synthetic-one',name:'الموظف الأول'},{id:'synthetic-two',name:'الموظف الثاني'}],
    expectedRecipients:['synthetic-one'], expectedBody:'أهلا وسهلا' },
  { text:'أضف مهمة تجهيز التقرير الشهري بمشروع الاختبار، أولوية خضرا، بدون مسؤول حاليًا وبدون موعد', kinds:['task_draft'],
    expectedPriority:'green', expectedMode:'start' },
  { text:'خلي أولوية التقرير التجريبي خضرا', kinds:['command'], action:'edit_task', expectedPriority:'green' },
  { text:'سجل تحديث على التقرير التجريبي: أنجزت 60٪ وبستنى رد المورد', kinds:['command','clarify'], action:'comment' },
  { text:'أصفر', kinds:['task_draft'], expectedPriority:'yellow', expectedMode:'continue',
    taskDraft:{projectId:'synthetic-project',title:'تجهيز تقرير تجريبي',details:null,priority:null,ownerId:'unassigned',dueDate:'unscheduled'},
    history:[{role:'user',content:'أضف مهمة تجهيز تقرير تجريبي بمشروع الاختبار بدون مسؤول وبدون موعد'},
      {role:'assistant',content:'شو أولويتها: أحمر عالية، أصفر عادية، ولا أخضر منخفضة؟'}] },
  { text:'أضف مهمة تجهيز التقرير الشهري', kinds:['task_draft'], expectedMode:'start' },
];
const index = Number(process.argv.find(a=>a.startsWith('--case='))?.slice(7));
if (!Number.isInteger(index) || !cases[index]) {
  console.log(JSON.stringify({ok:false,error:'select_synthetic_case_0_to_12'}));
  process.exitCode=1;
} else {
  try {
    const settings=readTeamChatSettings(); const chosen=cases[index];
    const {kinds,action,taskId,expectedRecipients,expectedBody,expectedPriority,expectedMode,...values}=chosen;
    let httpStatus=null;
    const plan=await inferSecretaryIntent({...base,...values}, {
      apiKey:settings.GROQ_API_KEY,model:settings.GROQ_MODEL,
      fetcher:async(...args)=>{const response=await fetch(...args);httpStatus=response.status;return response;},
    });
    const ok=kinds.includes(plan.kind) && (plan.kind!=='command'||plan.action===action)
      && (!taskId||plan.taskId===taskId)
      && (!expectedRecipients||JSON.stringify(plan.recipientIds)===JSON.stringify(expectedRecipients)
        || (expectedRecipients.length===1 && expectedRecipients[0]==='all-team'
          && JSON.stringify([...plan.recipientIds].sort())===JSON.stringify(values.messageRecipients.map(user=>user.id).sort())))
      && (!expectedBody||plan.fields.body===expectedBody)
      && (!expectedPriority||plan.fields.priority===expectedPriority)
      && (!expectedMode||plan.intakeMode===expectedMode);
    console.log(JSON.stringify({case:index,ok,kind:plan.kind,action:plan.action,taskId:plan.taskId,httpStatus,
      // All inputs are fixed synthetic values; prose helps review real language quality.
      reply:plan.message,...(expectedRecipients?{recipientIds:plan.recipientIds,body:plan.fields.body}:{}),
      ...((expectedMode||expectedPriority)?{intakeMode:plan.intakeMode,projectId:plan.projectId,fields:plan.fields}:{})}));
    if(!ok)process.exitCode=1;
  } catch {
    console.log(JSON.stringify({case:index,ok:false,error:'synthetic_provider_check_unavailable'}));
    process.exitCode=1;
  }
}
