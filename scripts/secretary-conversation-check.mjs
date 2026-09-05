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
];
const index = Number(process.argv.find(a=>a.startsWith('--case='))?.slice(7));
if (!Number.isInteger(index) || !cases[index]) {
  console.log(JSON.stringify({ok:false,error:'select_synthetic_case_0_to_5'}));
  process.exitCode=1;
} else {
  try {
    const settings=readTeamChatSettings(); const chosen=cases[index];
    const {kinds,action,taskId,...values}=chosen;
    let httpStatus=null;
    const plan=await inferSecretaryIntent({...base,...values}, {
      apiKey:settings.GROQ_API_KEY,model:settings.GROQ_MODEL,
      fetcher:async(...args)=>{const response=await fetch(...args);httpStatus=response.status;return response;},
    });
    const ok=kinds.includes(plan.kind) && (plan.kind!=='command'||plan.action===action)
      && (!taskId||plan.taskId===taskId);
    console.log(JSON.stringify({case:index,ok,kind:plan.kind,action:plan.action,taskId:plan.taskId,httpStatus,
      // All inputs are fixed synthetic values; prose helps review real language quality.
      reply:plan.message}));
    if(!ok)process.exitCode=1;
  } catch {
    console.log(JSON.stringify({case:index,ok:false,error:'synthetic_provider_check_unavailable'}));
    process.exitCode=1;
  }
}
