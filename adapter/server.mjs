import http from "node:http"
import crypto from "node:crypto"
import { migrateStore,getJobById,getJobByIdempotency,createJob,claimJob,updateJob,deleteJob,closeStore } from "./db.mjs"
import { runProvision } from "./providers.mjs"

const port=Number(process.env.PORT||8787)
const secret=process.env.TENANT_ADAPTER_SECRET
if(!secret)throw new Error("TENANT_ADAPTER_SECRET is required")

const json=(res,status,body)=>{res.writeHead(status,{"content-type":"application/json","cache-control":"no-store"});res.end(JSON.stringify(body))}
function safeError(error,input){
  let message=String(error?.message||"Provisioning failed.")
  const secret=input?.secret
  if(secret&&typeof secret==="object")for(const value of Object.values(secret))if(typeof value==="string"&&value.length>=8)message=message.split(value).join("[REDACTED]")
  return message.slice(0,1000)
}
const authorized=req=>{const a=Buffer.from(req.headers.authorization||"");const b=Buffer.from("Bearer "+secret);return a.length===b.length&&crypto.timingSafeEqual(a,b)}
async function body(req){let raw="";for await(const c of req){raw+=c;if(raw.length>512000)throw new Error("Request too large")}return JSON.parse(raw||"{}")}
function publicJob(row){
  if(!row)return null
  const safeResource=row.resource&&typeof row.resource==="object"?{...row.resource,deployKey:undefined,password:undefined,databasePassword:undefined,managementToken:undefined,token:undefined}:row.resource
  return {jobId:row.job_id,tenantId:row.tenant_id,provider:row.provider,status:row.status,step:row.step,attempt:row.attempt,resource:safeResource,result:row.result,errorCode:row.error_code,errorMessage:row.error_message,createdAt:row.created_at,updatedAt:row.updated_at,startedAt:row.started_at,completedAt:row.completed_at}
}
async function execute(jobId,inputOverride=null){
  const job=await claimJob(jobId); if(!job)return
  try{
    const provisionInput=inputOverride??job.input
    if(!provisionInput?.secret)throw Object.assign(new Error("Provider credentials must be supplied for each provisioning execution."),{code:"INVALID_PROVIDER_CONFIGURATION",retryable:false})
    const result=await runProvision(provisionInput,jobId,async(step,resource)=>{await updateJob(jobId,{status:"RUNNING",step,resource});return resource})
    await updateJob(jobId,{status:"SUCCEEDED",step:"ACTIVE",resource:result,result})
  }catch(error){
    const retryable=error?.retryable!==false&&!["UNSUPPORTED_PROVIDER","INVALID_REQUEST"].includes(error?.code)
    await updateJob(jobId,{status:retryable?"FAILED_RETRYABLE":"FAILED_FATAL",step:"FAILED",errorCode:error?.code||"PROVISIONING_FAILED",errorMessage:safeError(error,provisionInput),completedAt:new Date()})
  }
}

async function main(){
  await migrateStore()
  const server=http.createServer(async(req,res)=>{
    try{
      if(req.method==="GET"&&req.url==="/health")return json(res,200,{ok:true,service:"jusclick-tenant-provider-adapter",version:3})
      if(!authorized(req))return json(res,401,{ok:false,message:"Unauthorized"})
      const url=new URL(req.url,"http://adapter")
      if(req.method==="POST"&&url.pathname==="/v1/tenant/provision"){
        const input=await body(req)
        if(input.version!==1||!input.tenantId||!input.tenantSlug||!input.provider||!input.idempotencyKey||!input.ownerEmail)return json(res,400,{ok:false,code:"INVALID_REQUEST",message:"Required provisioning fields are missing."})
        if(!["convex","supabase","mysql"].includes(input.provider))return json(res,400,{ok:false,code:"UNSUPPORTED_PROVIDER",message:"Unsupported provider."})
        const existing=await getJobByIdempotency(input.idempotencyKey)
        if(existing&&existing.status==="SUCCEEDED")return json(res,200,{ok:true,...publicJob(existing)})
        if(existing&&["QUEUED","RUNNING","RETRY_WAIT"].includes(existing.status))return json(res,202,{ok:false,code:"PROVISIONING_IN_PROGRESS",...publicJob(existing)})
        if(existing){
          await updateJob(existing.job_id,{status:"RETRY_WAIT",step:"RETRY_WAIT",errorCode:null,errorMessage:null,completedAt:null})
          queueMicrotask(()=>execute(existing.job_id,input))
          return json(res,202,{ok:false,code:"PROVISIONING_RETRY_QUEUED",...publicJob(await getJobById(existing.job_id))})
        }
        const job=await createJob(input,crypto.randomUUID())
        queueMicrotask(()=>execute(job.job_id,input))
        return json(res,202,{ok:false,code:"PROVISIONING_QUEUED",...publicJob(job)})
      }
      const byKey=url.pathname.match(/^\/v1\/tenant\/provision\/by-key\/(.+)$/)
      if(req.method==="GET"&&byKey){
        const key=decodeURIComponent(byKey[1]);const job=await getJobByIdempotency(key)
        if(!job)return json(res,404,{ok:false,code:"NOT_FOUND",message:"Provisioning job not found."})
        return json(res,200,{ok:true,...publicJob(job)})
      }
      const match=url.pathname.match(/^\/v1\/tenant\/provision\/([^/]+)$/)
      if(req.method==="GET"&&match){
        const job=await getJobById(match[1]);if(!job)return json(res,404,{ok:false,code:"NOT_FOUND",message:"Provisioning job not found."})
        return json(res,200,{ok:true,...publicJob(job)})
      }
      if(req.method==="POST"&&url.pathname==="/v1/tenant/provision/retry"){
        const input=await body(req);const job=input.jobId?await getJobById(input.jobId):await getJobByIdempotency(input.idempotencyKey)
        if(!job)return json(res,404,{ok:false,code:"NOT_FOUND",message:"Provisioning job not found."})
        if(job.status==="SUCCEEDED")return json(res,200,{ok:true,...publicJob(job)})
        if(!input.secret||typeof input.secret!=="object"||Array.isArray(input.secret))return json(res,400,{ok:false,code:"INVALID_PROVIDER_CONFIGURATION",message:"Provider credentials are required to retry provisioning."})
        await updateJob(job.job_id,{status:"RETRY_WAIT",step:"RETRY_WAIT",errorCode:null,errorMessage:null,completedAt:null})
        queueMicrotask(()=>execute(job.job_id,{...job.input,secret:input.secret}))
        return json(res,202,{ok:false,code:"PROVISIONING_RETRY_QUEUED",...publicJob(await getJobById(job.job_id))})
      }
      if(req.method==="DELETE"&&url.pathname==="/v1/tenant/provision"){
        const input=await body(req)
        const job=input.jobId?await getJobById(input.jobId):await getJobByIdempotency(input.idempotencyKey)
        if(!job)return json(res,200,{ok:true,deleted:false,reason:"NOT_FOUND"})
        if(job.status==="SUCCEEDED")return json(res,409,{ok:false,code:"PROVISIONING_ACTIVE",message:"A successful provisioning record cannot be deleted through the failed-provision cleanup endpoint."})
        if(["QUEUED","RUNNING","RETRY_WAIT"].includes(job.status))return json(res,409,{ok:false,code:"PROVISIONING_IN_PROGRESS",message:"Provisioning is still running and cannot be deleted."})
        const deleted=await deleteJob(job.job_id)
        return json(res,200,{ok:true,deleted})
      }
      return json(res,404,{ok:false,message:"Not found"})
    }catch(error){return json(res,400,{ok:false,code:error?.code||"BAD_REQUEST",message:String(error?.message||"Invalid request.")})}
  })
  server.listen(port,()=>console.log("tenant provider adapter listening on "+port))
  const shutdown=async()=>{server.close();await closeStore();process.exit(0)}
  process.on("SIGTERM",shutdown);process.on("SIGINT",shutdown)
}
main().catch(e=>{console.error(e);process.exit(1)})
