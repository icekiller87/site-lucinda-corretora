const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{"content-type":"application/json; charset=utf-8"}});
const allowedEvents=new Set(["page_view","whatsapp_click","phone_click","instagram_click","hero_quote_submit","table_quote_submit","contact_form_submit","callback_request"]);

export default async(request,context)=>{
  if(request.method!=="POST")return json({error:"Method not allowed"},405);
  try{
    const body=await request.json();
    if(!allowedEvents.has(body.event_name))return json({error:"Invalid event"},400);
    const url=process.env.SUPABASE_URL,key=process.env.SUPABASE_PUBLISHABLE_KEY;
    if(!url||!key)return json({error:"Analytics unavailable"},503);
    let referrerDomain=null;
    if(body.referrer){try{referrerDomain=new URL(body.referrer).hostname.slice(0,160)}catch{}}
    const response=await fetch(`${url}/rest/v1/lucinda_analytics_events`,{
      method:"POST",
      headers:{"content-type":"application/json",apikey:key,authorization:`Bearer ${key}`,prefer:"return=minimal"},
      body:JSON.stringify({event_name:body.event_name,page_path:String(body.page_path||"/").slice(0,200),referrer_domain:referrerDomain,device_type:["mobile","tablet","desktop"].includes(body.device_type)?body.device_type:null,city:context.geo?.city||null,country:context.geo?.country?.name||null})
    });
    if(!response.ok)return json({error:"Storage unavailable"},502);
    return json({ok:true},201);
  }catch{return json({error:"Invalid request"},400)}
};
